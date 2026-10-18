import { Request, Response } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSongsQueryDTO } from '../dtos/ListSongsQueryDTO';
import { formatValidationErrors } from '../middlewares/validate';
import { routeParam } from '../utils/routeParams';
import { generateListenerKey } from '../utils/listenerKey';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import { SongPlayEvent } from '../entities/SongPlayEvent';
import { SongSave } from '../entities/SongSave';
import redis from '../config/redis';
import { precomputeSignedManifest } from '../workers/precomputeManifest';
import { handleError, handleOnChainError } from '../utils/helpers';
import { AppError } from '../errors/AppError';
import { SongService } from '../services/SongService';
import { CollaborationService } from '../services/CollaborationService';
import { TagService } from '../services/TagService';
import { SongStatsService, parseWindow } from '../services/Song/SongStatsService';
import { SongVersionService } from '../services/Song/SongVersionService';
import { ReportService } from '../services/ReportService';
import { CoverArtService } from '../services/CoverArtService';
import { PlaybackService } from '../services/Song/PlaybackService';
import logger from '../config/logger';

const songService = new SongService();
const collaborationService = new CollaborationService();
const tagService = new TagService();
const songStatsService = new SongStatsService();
const songVersionService = new SongVersionService();
const reportService = new ReportService();
const playbackService = new PlaybackService();
const coverArtService = new CoverArtService();

export class SongController {
  static getSong = async (req: Request, res: Response) => {
    try {
      const song = await songService.getSongView(routeParam(req.params.id), (req as any).user?.id);
      return res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static updateSong = async (req: Request, res: Response) => {
    try {
      const song = await songService.updateSong(req.params.id as string, req.body, req.user!);
      return res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static deleteSong = async (req: Request, res: Response) => {
    try {
      const result = await songService.deleteSong(req.params.id as string, req.user!);
      return res.status(200).json({ success: true, data: { hidden: result.hidden } });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static listSongs = async (req: Request, res: Response) => {
    try {
      const query = plainToInstance(ListSongsQueryDTO, req.query, {
        enableImplicitConversion: true,
      });
      const errors = await validate(query);
      if (errors.length > 0) {
        throw AppError.validation('Validation failed', formatValidationErrors(errors));
      }
      const result = await songService.listSongs(query, (req as any).user?.id);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static flagSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const adminId = (req as any).user.id as string;
      const { reason } = req.body;
      const song = await songService.flagSong(songId, adminId, reason);
      return res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static unflagSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const adminId = (req as any).user.id as string;
      const song = await songService.unflagSong(songId, adminId);
      return res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static prepareMint = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const albumId = req.body?.albumId ? Number(req.body.albumId) : 0;
      const prepared = await songService.prepareSongMintTx(songId, albumId);
      return res.status(200).json({ success: true, data: prepared });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static submitMint = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const { signedXdr } = req.body;
      const result = await songService.submitSongMintTx(songId, signedXdr);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      handleOnChainError(req, res, error);
    }
  };

  static streamSong = async (req: Request, res: Response) => {
    const songId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    try {
      const songRepo = AppDataSource.getRepository(Song);
      const song = await songRepo.findOne({ where: { id: songId } });
      if (!song || song.status !== 'ready' || !song.hlsMasterUrl || song.flagged) {
        throw AppError.notFound('Song not available', undefined, 'SONG_NOT_AVAILABLE');
      }

      const sessionKey = `play:throttle:${req.ip}:${songId}`;
      const recentlyPlayed = await redis.get(sessionKey);
      if (!recentlyPlayed) {
        await songRepo.increment({ id: songId }, 'playCount', 1);
        // Record who listened so unique-listener statistics can be computed
        // per time window (Issue #87). Anonymous streams get a hashed IP key
        // instead of storing the raw address (Issue #793: HMAC-SHA256 with LISTENER_KEY_SALT).
        const listenerId = (req as any).user?.id ?? null;
        const listenerKey = listenerId ? null : generateListenerKey(req.ip);
        await AppDataSource.getRepository(SongPlayEvent).insert({
          songId,
          listenerId,
          listenerKey,
        });
        await redis.set(sessionKey, '1', 'EX', 30);
      }

      const cacheKey = `manifest:${songId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(cached);
      }

      const generated = await precomputeSignedManifest(songId);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(generated);
    } catch (err) {
      logger.error({ reqId: (req as any).id, route: req.path, err }, 'Stream error');
      handleError(req, res, err);
    }
  };

  static searchSongs = async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string) || '';
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      if (q.trim().length > 0 && q.trim().length < 2) {
        return res.status(200).json({
          success: true,
          query: q,
          songs: [],
          total: 0,
          page,
          limit,
          totalPages: 0,
          message: 'Search query must be at least 2 characters',
        });
      }

      const result = await songService.searchSongs(q, page, limit);

      return res.status(200).json({
        success: true,
        query: q,
        ...result,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static applyTemplate = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const userId = (req as any).user?.id as string;
      const { templateId } = req.body;

      if (!templateId) {
        return res.status(400).json({ success: false, message: 'templateId is required' });
      }

      const song = await songService.applyTemplate(songId, templateId, userId);
      res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(res, error);
    }
  };

  static getPopularSongs = async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const songRepo = AppDataSource.getRepository(Song);
      const [songs, total] = await songRepo.findAndCount({
        where: { status: 'ready' },
        order: { playCount: 'DESC' },
        skip,
        take: limit,
      });

      return res.status(200).json({
        success: true,
        data: songs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static listCollaborators = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const collaborators = await collaborationService.listCollaborators(songId);
      return res.status(200).json({ success: true, data: collaborators });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static addCollaborator = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const requesterId = (req as any).user.id as string;
      const { userId, role, royaltyShare } = req.body;
      const collaborator = await collaborationService.addCollaborator(songId, requesterId, {
        userId,
        role,
        royaltyShare,
      });
      return res.status(201).json({ success: true, data: collaborator });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static updateCollaborator = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const targetUserId = req.params.userId as string;
      const requesterId = (req as any).user.id as string;
      const { role, royaltyShare } = req.body;
      const collaborator = await collaborationService.updateCollaborator(
        songId,
        targetUserId,
        requesterId,
        { role, royaltyShare },
      );
      return res.status(200).json({ success: true, data: collaborator });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static disputeSplit = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const requesterId = (req as any).user.id as string;
      const collaborator = await collaborationService.disputeSplit(songId, requesterId);
      return res.status(200).json({ success: true, data: collaborator });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static resolveDispute = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const targetUserId = req.params.userId as string;
      const requesterId = (req as any).user.id as string;
      const collaborator = await collaborationService.resolveDispute(
        songId,
        targetUserId,
        requesterId,
      );
      return res.status(200).json({ success: true, data: collaborator });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static addTags = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const { tags } = req.body;
      if (!Array.isArray(tags) || tags.length === 0) {
        throw AppError.validation('tags must be a non-empty array of tag names');
      }
      const result = await tagService.addTagsToSong(songId, tags);
      return res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  static retryFailedSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const song = await songService.retryFailedSong(songId);
      return res.status(200).json({
        success: true,
        message: 'Song re-queued for processing',
        data: song,
      });
    } catch (error) {
      handleError(res, error);
    }
  };

  /** GET /api/songs/:id/stats — aggregated song statistics (Issue #87). */
  static getSongStats = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const window = parseWindow(req.query.window);
      const stats = await songStatsService.getSongStats(songId, window);
      return res.status(200).json({ success: true, data: stats });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** GET /api/artists/:id/stats — artist-level aggregation (Issue #87). */
  static getArtistStats = async (req: Request, res: Response) => {
    try {
      const artistId = req.params.id as string;
      const window = parseWindow(req.query.window);
      const stats = await songStatsService.getArtistStats(artistId, window);
      return res.status(200).json({ success: true, data: stats });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * POST /api/songs/:id/save — add a song to the caller's library (Issue #87).
   *
   * Saves are the data source for the `saves` statistic; a repeat save is a
   * no-op rather than an error so the client can be idempotent.
   */
  static saveSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const userId = (req as any).user.id as string;

      const songRepo = AppDataSource.getRepository(Song);
      const song = await songRepo.findOneBy({ id: songId });
      if (!song) {
        throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
      }

      const saveRepo = AppDataSource.getRepository(SongSave);
      const existing = await saveRepo.findOne({ where: { songId, userId } });
      if (existing) {
        return res.status(200).json({ success: true, message: 'Song already saved' });
      }

      await saveRepo.insert({ songId, userId });
      await songStatsService.invalidateSong(songId, song.artistId);

      return res.status(201).json({ success: true, message: 'Song saved' });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** DELETE /api/songs/:id/save — remove a song from the caller's library. */
  static unsaveSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const userId = (req as any).user.id as string;

      const saveRepo = AppDataSource.getRepository(SongSave);
      const result = await saveRepo.delete({ songId, userId });
      if (!result.affected) {
        throw AppError.notFound('Song is not saved', undefined, 'SAVE_NOT_FOUND');
      }

      const song = await AppDataSource.getRepository(Song).findOneBy({ id: songId });
      await songStatsService.invalidateSong(songId, song?.artistId);

      return res.status(200).json({ success: true, message: 'Song removed from library' });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** GET /api/songs/:id/versions — every revision of a song (Issue #86). */
  static listVersions = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      await songVersionService.assertCanViewHistory(songId, req.user!);
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await songVersionService.listVersions(songId, page, limit);
      return res.status(200).json({
        success: true,
        data: result.versions,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** GET /api/songs/:id/versions/:version — one specific revision (Issue #86). */
  static getVersion = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      await songVersionService.assertCanViewHistory(songId, req.user!);
      const versionNumber = Number(req.params.version);
      const version = await songVersionService.getVersion(songId, versionNumber);
      return res.status(200).json({ success: true, data: version });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** POST /api/songs/:id/report — submit a content report (Issue #88). */
  static reportSong = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const reporterId = (req as any).user.id as string;
      const { reason, description } = req.body;

      const result = await reportService.submitReport(songId, reporterId, { reason, description });

      return res.status(201).json({
        success: true,
        message: 'Report submitted',
        data: {
          report: result.report,
          songFlagged: result.songFlagged,
          pendingReports: result.pendingReports,
        },
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** GET /api/songs/:id/lyrics — get lyrics for a song (Issue #75). */
  static getLyrics = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const lyricsData = await songService.getLyrics(songId);
      return res.status(200).json({ success: true, data: lyricsData });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** POST /api/songs/:id/cover-art — upload + associate cover art (Issue #80). */
  static uploadCoverArt = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const userId = (req as any).user.id as string;
      const file = (req as any).file as Express.Multer.File | undefined;

      if (!file) {
        throw AppError.validation('coverArt file is required', undefined, 'COVER_ART_REQUIRED');
      }

      const song = await coverArtService.uploadCoverArt(songId, userId, file);
      return res.status(200).json({ success: true, data: song });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** GET /api/songs/:id/cover-art — cover art URLs incl. thumbnails (Issue #80). */
  static getCoverArt = async (req: Request, res: Response) => {
    try {
      const songId = req.params.id as string;
      const data = await coverArtService.getCoverArt(songId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
