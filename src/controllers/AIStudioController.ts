import { Request, Response, NextFunction } from 'express';
import { AiGenerationService } from '../services/ai/AiGenerationService';
import { TagSuggestionService } from '../services/TagSuggestionService';
import { TweetDraftService } from '../services/TweetDraftService';
import AppDataSource from '../config/db';
import { User } from '../entities/User';
import { AiGenerationRecord } from '../entities/AiGenerationRecord';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import { HTTP_STATUS } from '../config/constants';
import { routeParam } from '../utils/routeParams';

const aiGenerationService = new AiGenerationService();
const tagSuggestionService = new TagSuggestionService();
const tweetDraftService = new TweetDraftService();

/** Rejects requests when the artist has not opted into AI Studio. */
export const requireAiStudioEnabled = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = (req as any).user?.id as string | undefined;
    if (!userId) throw AppError.authentication('Authentication required');
    const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
    if (!user || !user.aiStudioEnabled) {
      throw AppError.authorization(
        'AI Studio is not enabled for this artist',
        undefined,
        'AI_STUDIO_DISABLED',
      );
    }
    next();
  } catch (error) {
    handleError(req, res, error);
  }
};

/**
 * Single place for artists to see/manage AI-assisted upload tools,
 * gated by the per-artist `aiStudioEnabled` flag.
 */
export class AIStudioController {
  getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
      if (!user) throw AppError.notFound('User not found');
      res
        .status(HTTP_STATUS.OK)
        .json({ success: true, data: { aiStudioEnabled: user.aiStudioEnabled } });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  setEnabled = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const enabled = req.body?.enabled as boolean;
      if (typeof enabled !== 'boolean') throw AppError.validation('`enabled` must be a boolean');
      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOneBy({ id: userId });
      if (!user) throw AppError.notFound('User not found');
      user.aiStudioEnabled = enabled;
      await repo.save(user);
      res
        .status(HTTP_STATUS.OK)
        .json({ success: true, data: { aiStudioEnabled: user.aiStudioEnabled } });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** Overview: recent AI generations + tag/draft entry points. */
  getOverview = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const records = await AppDataSource.getRepository(AiGenerationRecord).find({
        where: { userId },
        order: { createdAt: 'DESC' },
        take: 20,
      });
      const drafts = await tweetDraftService.listDrafts(userId);
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { generations: records, tweetDrafts: drafts },
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  requestCoverArt = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const songId = routeParam(req.params.songId);
      const record = await aiGenerationService.requestGeneration('coverArt', songId, userId);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: record });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  requestDescription = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const songId = routeParam(req.params.songId);
      const record = await aiGenerationService.requestGeneration('descriptions', songId, userId);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: record });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * Issue #285: opt-in lyric transcription. The body must carry
   * `rightsConfirmed: true` — the artist's confirmation that they hold the
   * rights to the lyrics — or the request is rejected before anything runs.
   */
  requestLyricsTranscription = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const songId = routeParam(req.params.songId);
      const record = await aiGenerationService.requestGeneration(
        'lyricsTranscription',
        songId,
        userId,
        { rightsConfirmed: req.body?.rightsConfirmed },
      );
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: record });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  suggestTags = async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, description } = req.body;
      const user = (req as any).user;
      const suggestions = await tagSuggestionService.suggestTagsAndGenres({
        title,
        description,
        artistName: user?.username || user?.name,
      });
      res.status(HTTP_STATUS.OK).json({ success: true, data: suggestions });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  createTweetDraft = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user.id as string;
      const draft = await tweetDraftService.createDraft(userId, req.body?.songId);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: draft });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
