import { Repository } from 'typeorm';
import AppDataSource from '../../config/db';
import { Song } from '../../entities/Song';
import { SongVersion } from '../../entities/SongVersion';
import { UserRole } from '../../entities/User';
import { AppError } from '../../errors/AppError';
import { CacheService } from '../CacheService';
import logger from '../../config/logger';

/** Fields a re-upload may change on the new version. */
export interface VersionInput {
  title?: string;
  description?: string;
  genre?: string;
  composers?: string;
  coverArtPath?: string;
  s3OriginalUrl?: string;
  ipfsCid?: string;
  changeNote?: string;
  createdBy?: string;
}

/**
 * Song revision management (Issue #86).
 *
 * A song's audio and metadata are never overwritten by a re-upload. Instead
 * each upload is recorded as a {@link SongVersion} row, the new revision
 * becomes the active one, and previous revisions keep their IPFS CIDs so
 * royalty calculations that reference a specific revision remain resolvable.
 */
export class SongVersionService {
  private songRepo: Repository<Song>;
  private versionRepo: Repository<SongVersion>;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
    this.versionRepo = AppDataSource.getRepository(SongVersion);
  }

  /**
   * Record the initial revision for a freshly uploaded song.
   *
   * Called from the upload finalize path so every song has a version 1 row
   * even if it is never re-uploaded.
   *
   * @param song - The persisted Song entity.
   * @param createdBy - ID of the uploading artist.
   * @returns The created version 1 record.
   */
  async createInitialVersion(song: Song, createdBy?: string): Promise<SongVersion> {
    const existing = await this.versionRepo.count({ where: { songId: song.id } });
    if (existing > 0) {
      throw AppError.conflict('Song already has versions', undefined, 'VERSION_ALREADY_EXISTS');
    }

    const version = this.versionRepo.create({
      songId: song.id,
      versionNumber: 1,
      isActive: true,
      title: song.title,
      description: song.description,
      genre: song.genre,
      composers: song.composers,
      coverArtPath: song.coverArtPath,
      s3OriginalUrl: song.s3OriginalUrl,
      hlsMasterUrl: song.hlsMasterUrl,
      ipfsCid: song.ipfsCid,
      metadataCid: song.metadataCid,
      duration: song.duration,
      loudness: song.loudness,
      status: song.status,
      changeNote: 'Initial upload',
      createdBy: createdBy ?? song.artistId,
    });

    return this.versionRepo.save(version);
  }

  /**
   * Create a new revision for an existing song without discarding the previous
   * one, and promote it to active.
   *
   * The parent Song row is updated to point at the new revision's assets so
   * streaming serves the latest audio, while the superseded version row keeps
   * its own `ipfsCid` / `s3OriginalUrl`.
   *
   * @param songId - ID of the song being re-uploaded.
   * @param artistId - ID of the artist performing the re-upload.
   * @param input - Changed metadata and new asset locations.
   * @returns The newly created, active version.
   * @throws {AppError} 404 when the song does not exist, 403 when the caller
   *   does not own it.
   */
  // eslint-disable-next-line complexity -- existing method tracked in docs/refactoring_priority.md
  async createVersionFromReupload(
    songId: string,
    artistId: string,
    input: VersionInput,
  ): Promise<SongVersion> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }
    if (song.artistId !== artistId) {
      throw AppError.authorization(
        'Not authorized to re-upload this song',
        undefined,
        'NOT_SONG_OWNER',
      );
    }

    // Ensure the pre-existing state is captured as version 1 for songs that
    // predate versioning, so history is never silently lost.
    const versionCount = await this.versionRepo.count({ where: { songId } });
    if (versionCount === 0) {
      await this.createInitialVersion(song, song.artistId);
    }

    const nextNumber = (await this.getLatestVersionNumber(songId)) + 1;

    // Demote every existing revision before promoting the new one so the
    // "exactly one active version" invariant holds.
    await this.versionRepo.update({ songId, isActive: true }, { isActive: false });

    const version = this.versionRepo.create({
      songId,
      versionNumber: nextNumber,
      isActive: true,
      title: input.title ?? song.title,
      description: input.description ?? song.description,
      genre: input.genre ?? song.genre,
      composers: input.composers ?? song.composers,
      coverArtPath: input.coverArtPath ?? song.coverArtPath,
      s3OriginalUrl: input.s3OriginalUrl,
      ipfsCid: input.ipfsCid,
      status: 'processing',
      changeNote: input.changeNote ?? null,
      createdBy: input.createdBy ?? artistId,
    });
    await this.versionRepo.save(version);

    // Point the parent song at the new revision. HLS/metadata CIDs are filled
    // in by the processor worker once transcoding finishes.
    song.title = version.title ?? song.title;
    if (version.description !== undefined) song.description = version.description as string;
    if (version.genre !== undefined) song.genre = version.genre as string;
    if (version.composers !== undefined) song.composers = version.composers;
    if (input.coverArtPath) song.coverArtPath = input.coverArtPath;
    if (input.s3OriginalUrl) song.s3OriginalUrl = input.s3OriginalUrl;
    if (input.ipfsCid) song.ipfsCid = input.ipfsCid;
    song.status = 'processing';
    song.errorReason = null;
    await this.songRepo.save(song);

    await CacheService.clearSong(songId);

    logger.info({ songId, versionNumber: nextNumber }, 'Created new song version');

    return version;
  }

  /**
   * Version history can include unreleased audio, so only the owning artist
   * and admins may read it.
   *
   * @throws {AppError} 404 when the song does not exist, 403 for anyone else.
   */
  async assertCanViewHistory(songId: string, requester: { id: string; role?: UserRole }) {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }
    if (song.artistId !== requester.id && requester.role !== UserRole.ADMIN) {
      throw AppError.authorization(
        'Not authorized to view versions of this song',
        undefined,
        'NOT_SONG_OWNER',
      );
    }
  }

  /**
   * List the revisions of a song, newest first.
   *
   * @param songId - ID of the song.
   * @param page - 1-based page number.
   * @param limit - Page size, capped at 100.
   * @throws {AppError} 404 when the song does not exist.
   */
  async listVersions(songId: string, page = 1, limit = 20) {
    await this.assertSongExists(songId);
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);

    const [versions, total] = await this.versionRepo.findAndCount({
      where: { songId },
      order: { versionNumber: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
    return {
      versions,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 0,
      },
    };
  }

  /**
   * Fetch one specific revision of a song.
   *
   * @param songId - ID of the song.
   * @param versionNumber - 1-based revision number.
   * @throws {AppError} 400 for a non-numeric version, 404 when song or
   *   version does not exist.
   */
  async getVersion(songId: string, versionNumber: number): Promise<SongVersion> {
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw AppError.validation('version must be a positive integer', undefined, 'INVALID_VERSION');
    }
    await this.assertSongExists(songId);

    const version = await this.versionRepo.findOne({ where: { songId, versionNumber } });
    if (!version) {
      throw AppError.notFound(
        `Version ${versionNumber} not found for this song`,
        undefined,
        'VERSION_NOT_FOUND',
      );
    }
    return version;
  }

  /** Return the currently served revision, or null when a song has none yet. */
  async getActiveVersion(songId: string): Promise<SongVersion | null> {
    return this.versionRepo.findOne({ where: { songId, isActive: true } });
  }

  /**
   * Propagate processing results (HLS URL, metadata CID, status) onto the
   * active revision once the worker finishes transcoding.
   *
   * @param songId - ID of the processed song.
   * @param update - Processing outputs to persist on the active version.
   */
  async syncActiveVersion(
    songId: string,
    update: {
      status?: 'processing' | 'ready' | 'failed';
      hlsMasterUrl?: string;
      metadataCid?: string;
      duration?: number;
      loudness?: number;
      errorReason?: string | null;
    },
  ): Promise<SongVersion | null> {
    const active = await this.getActiveVersion(songId);
    if (!active) return null;

    Object.assign(active, update);
    return this.versionRepo.save(active);
  }

  /** Highest version number recorded for a song, or 0 when it has none. */
  private async getLatestVersionNumber(songId: string): Promise<number> {
    const latest = await this.versionRepo.findOne({
      where: { songId },
      order: { versionNumber: 'DESC' },
    });
    return latest?.versionNumber ?? 0;
  }

  private async assertSongExists(songId: string): Promise<void> {
    const exists = await this.songRepo.findOneBy({ id: songId });
    if (!exists) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }
  }
}
