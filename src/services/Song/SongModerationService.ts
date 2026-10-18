import { In, Repository } from 'typeorm';
import AppDataSource from '../../config/db';
import { Song } from '../../entities/Song';
import { AppError } from '../../errors/AppError';
import { TransactionLogService } from '../TransactionLogService';
import { CacheService } from '../CacheService';
import logger from '../../config/logger';

/** Actions an admin can apply in a bulk moderation request (Issue #85). */
export enum BulkModerationAction {
  APPROVE = 'approve',
  REJECT = 'reject',
  FLAG_FOR_REVIEW = 'flag_for_review',
}

/** Maximum number of songs accepted in one bulk request. */
export const BULK_MODERATION_MAX_BATCH = 50;

const VALID_ACTIONS = Object.values(BulkModerationAction);

/** Per-song outcome so partial failures are reported rather than swallowed. */
export interface BulkModerationResult {
  songId: string;
  success: boolean;
  status?: Song['status'];
  flagged?: boolean;
  reason?: string;
}

export interface BulkModerationResponse {
  action: BulkModerationAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkModerationResult[];
}

/**
 * Bulk song moderation for admins (Issue #85).
 *
 * Each song in the batch is processed independently: one failure (missing song,
 * invalid transition) does not abort the rest, and every attempt produces a
 * result row. Every applied action writes an audit log entry.
 */
export class SongModerationService {
  private songRepo: Repository<Song>;
  private logService: TransactionLogService;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
    this.logService = new TransactionLogService();
  }

  /**
   * Apply one moderation action to a batch of songs.
   *
   * @param songIds - Song IDs to moderate (1..{@link BULK_MODERATION_MAX_BATCH}).
   * @param rawAction - approve / reject / flag_for_review.
   * @param adminId - ID of the acting admin, recorded in the audit log.
   * @returns Per-song results plus success/failure counts.
   * @throws {AppError} 400 when the batch is empty, oversized, or the action is
   *   not recognised.
   */
  async bulkModerate(
    songIds: unknown,
    rawAction: unknown,
    adminId: string,
  ): Promise<BulkModerationResponse> {
    const action = this.parseAction(rawAction);
    const ids = this.parseSongIds(songIds);

    const songs = await this.songRepo.find({ where: { id: In(ids) } });
    const bySongId = new Map(songs.map((s) => [s.id, s]));

    const results: BulkModerationResult[] = [];

    for (const songId of ids) {
      const song = bySongId.get(songId);
      if (!song) {
        results.push({ songId, success: false, reason: 'Song not found' });
        continue;
      }

      try {
        await this.applyAction(song, action, adminId);
        results.push({
          songId,
          success: true,
          status: song.status,
          flagged: song.flagged,
        });
      } catch (err) {
        results.push({
          songId,
          success: false,
          reason: err instanceof Error ? err.message : 'Moderation failed',
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;

    logger.info(
      { adminId, action, requested: ids.length, succeeded, failed: ids.length - succeeded },
      'Bulk song moderation completed',
    );

    return {
      action,
      requested: ids.length,
      succeeded,
      failed: ids.length - succeeded,
      results,
    };
  }

  /** Mutate one song for the given action and write its audit log entry. */
  private async applyAction(
    song: Song,
    action: BulkModerationAction,
    adminId: string,
  ): Promise<void> {
    switch (action) {
      case BulkModerationAction.APPROVE: {
        if (song.status === 'processing') {
          throw new Error('Song is still processing and cannot be approved');
        }
        song.flagged = false;
        song.flaggedAt = null;
        song.flaggedBy = null;
        song.flagReason = null;
        await this.songRepo.save(song);
        break;
      }

      case BulkModerationAction.REJECT: {
        song.flagged = true;
        song.flaggedAt = new Date();
        song.flaggedBy = adminId;
        song.flagReason = 'Rejected by admin moderation';
        song.status = 'failed';
        song.errorReason = 'Rejected by admin moderation';
        await this.songRepo.save(song);
        break;
      }

      case BulkModerationAction.FLAG_FOR_REVIEW: {
        song.flagged = true;
        song.flaggedAt = new Date();
        song.flaggedBy = adminId;
        song.flagReason = 'Flagged for review by admin moderation';
        await this.songRepo.save(song);
        break;
      }
    }

    await CacheService.clearSong(song.id);

    await this.logService.createLogEntry(
      adminId,
      '',
      `BULK_MODERATION_${action.toUpperCase()}`,
      `Admin ${adminId} applied ${action} to song ${song.id}`,
    );
  }

  private parseAction(raw: unknown): BulkModerationAction {
    const value = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (!VALID_ACTIONS.includes(value as BulkModerationAction)) {
      throw AppError.validation(
        `action must be one of: ${VALID_ACTIONS.join(', ')}`,
        { field: 'action', value: raw },
        'INVALID_MODERATION_ACTION',
      );
    }
    return value as BulkModerationAction;
  }

  private parseSongIds(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw AppError.validation(
        'songIds must be a non-empty array',
        { field: 'songIds' },
        'INVALID_SONG_IDS',
      );
    }
    if (raw.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw AppError.validation(
        'songIds must contain only non-empty strings',
        { field: 'songIds' },
        'INVALID_SONG_IDS',
      );
    }

    // De-duplicate so a repeated id is not moderated (and audit-logged) twice.
    const ids = [...new Set(raw.map((id) => (id as string).trim()))];

    if (ids.length > BULK_MODERATION_MAX_BATCH) {
      throw AppError.validation(
        `Batch size exceeds the maximum of ${BULK_MODERATION_MAX_BATCH} songs per request`,
        { field: 'songIds', value: ids.length },
        'BATCH_TOO_LARGE',
      );
    }

    return ids;
  }
}
