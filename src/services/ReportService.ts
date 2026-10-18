import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import { ContentReport, ReportAction, ReportReason, ReportStatus } from '../entities/ContentReport';
import { AppError } from '../errors/AppError';
import { TransactionLogService } from './TransactionLogService';
import { CacheService } from './CacheService';
import { getAiProvider } from './ai';
import { delimitUserContent, PROMPT_INJECTION_SYSTEM_PREAMBLE } from './AI/promptSafety';
import logger from '../config/logger';

/**
 * Number of pending reports that auto-flags a song for moderator review.
 * Configurable so the threshold can be tuned per-deployment.
 */
export const REPORT_AUTO_FLAG_THRESHOLD = Number(process.env.REPORT_AUTO_FLAG_THRESHOLD || 3);

const VALID_REASONS = Object.values(ReportReason);
const VALID_ACTIONS = Object.values(ReportAction);

export interface SubmitReportInput {
  reason: string;
  description?: string;
  /** Explicit consent to send report text to a third-party AI provider (#295). */
  aiConsent?: boolean;
}

export interface ResolveReportInput {
  actionTaken: string;
  resolutionNote?: string;
}

export interface PendingReportsPage {
  reports: ContentReport[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Community content moderation reports (Issue #88).
 *
 * Listeners submit at most one report per song. Once a song accumulates
 * {@link REPORT_AUTO_FLAG_THRESHOLD} pending reports it is auto-flagged, which
 * pulls it out of search and streaming until a moderator resolves the queue.
 */
export class ReportService {
  private reportRepo: Repository<ContentReport>;
  private songRepo: Repository<Song>;
  private logService: TransactionLogService;

  constructor() {
    this.reportRepo = AppDataSource.getRepository(ContentReport);
    this.songRepo = AppDataSource.getRepository(Song);
    this.logService = new TransactionLogService();
  }

  /**
   * Submit a content report against a song.
   *
   * @param songId - ID of the reported song.
   * @param reporterId - ID of the reporting user.
   * @param input - Reason category and optional free-text description.
   * @returns The created report and whether it tripped the auto-flag threshold.
   * @throws {AppError} 400 for an unknown reason, 404 when the song does not
   *   exist, 409 when this user already reported this song.
   */
  async submitReport(
    songId: string,
    reporterId: string,
    input: SubmitReportInput,
  ): Promise<{ report: ContentReport; songFlagged: boolean; pendingReports: number }> {
    const reason = this.parseReason(input.reason);

    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }

    const existing = await this.reportRepo.findOne({ where: { songId, reporterId } });
    if (existing) {
      throw AppError.conflict('You have already reported this song', undefined, 'DUPLICATE_REPORT');
    }

    const report = this.reportRepo.create({
      songId,
      reporterId,
      reason,
      description: input.description?.trim() || null,
      status: ReportStatus.PENDING,
      // Explicit, not implied: opt-in only (#295).
      aiConsent: input.aiConsent === true,
    });
    await this.reportRepo.save(report);

    // Issue #273: Score report with AI (fails open if AI call errors).
    // Skipped entirely unless the reporter opted in (#295).
    if (report.aiConsent) {
      await this.scoreReportWithAI(report, song);
    }

    const pendingReports = await this.reportRepo.count({
      where: { songId, status: ReportStatus.PENDING },
    });

    const songFlagged = await this.applyThreshold(song, pendingReports);

    return { report, songFlagged, pendingReports };
  }

  /**
   * Paginated queue of unresolved reports, oldest first so the backlog drains
   * in submission order.
   *
   * @param page - 1-based page number.
   * @param limit - Page size, capped at 100.
   * @param songId - Optional filter to one song's reports.
   */
  async listPendingReports(page = 1, limit = 20, songId?: string): Promise<PendingReportsPage> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);

    const [reports, total] = await this.reportRepo.findAndCount({
      where: songId ? { status: ReportStatus.PENDING, songId } : { status: ReportStatus.PENDING },
      order: { createdAt: 'ASC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      reports,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 0,
      },
    };
  }

  /**
   * Resolve a pending report, recording the action a moderator took.
   *
   * `song_flagged` and `song_removed` flag the song; `dismissed` / `no_action`
   * leave it as-is and, when no pending reports remain, clear an auto-flag so
   * a wrongly reported song is restored.
   *
   * @param reportId - ID of the report to resolve.
   * @param moderatorId - ID of the resolving moderator.
   * @param input - Action taken plus an optional note.
   * @throws {AppError} 400 for an unknown action, 404 when the report does not
   *   exist, 409 when it was already resolved.
   */
  async resolveReport(
    reportId: string,
    moderatorId: string,
    input: ResolveReportInput,
  ): Promise<ContentReport> {
    const action = this.parseAction(input.actionTaken);

    const report = await this.reportRepo.findOneBy({ id: reportId });
    if (!report) {
      throw AppError.notFound('Report not found', undefined, 'REPORT_NOT_FOUND');
    }
    if (report.status === ReportStatus.RESOLVED) {
      throw AppError.conflict('Report is already resolved', undefined, 'REPORT_ALREADY_RESOLVED');
    }

    report.status = ReportStatus.RESOLVED;
    report.actionTaken = action;
    report.resolvedBy = moderatorId;
    report.resolvedAt = new Date();
    report.resolutionNote = input.resolutionNote?.trim() || null;
    await this.reportRepo.save(report);

    await this.applyResolutionToSong(report.songId, moderatorId, action);

    await this.logService.createLogEntry(
      moderatorId,
      '',
      'REPORT_RESOLVED',
      `Report ${reportId} on song ${report.songId} resolved with action ${action}`,
    );

    return report;
  }

  /** Count of pending reports for a song, used by moderation views. */
  async countPendingForSong(songId: string): Promise<number> {
    return this.reportRepo.count({ where: { songId, status: ReportStatus.PENDING } });
  }

  /**
   * Flag the song once pending reports reach the threshold.
   *
   * @returns True when this call transitioned the song into a flagged state.
   */
  private async applyThreshold(song: Song, pendingReports: number): Promise<boolean> {
    if (song.flagged || pendingReports < REPORT_AUTO_FLAG_THRESHOLD) {
      return false;
    }

    song.flagged = true;
    song.flaggedAt = new Date();
    song.flaggedBy = null;
    song.flagReason = `Auto-flagged after ${pendingReports} pending content reports`;
    await this.songRepo.save(song);

    await CacheService.clearSong(song.id);

    logger.warn(
      { songId: song.id, pendingReports, threshold: REPORT_AUTO_FLAG_THRESHOLD },
      'Song auto-flagged by content report threshold',
    );

    return true;
  }

  /** Apply a moderator's resolution action to the reported song's status. */
  private async applyResolutionToSong(
    songId: string,
    moderatorId: string,
    action: ReportAction,
  ): Promise<void> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) return;

    if (action === ReportAction.SONG_FLAGGED || action === ReportAction.SONG_REMOVED) {
      song.flagged = true;
      song.flaggedAt = new Date();
      song.flaggedBy = moderatorId;
      song.flagReason = `Content report resolution: ${action}`;
      await this.songRepo.save(song);
      await CacheService.clearSong(songId);
      return;
    }

    // Dismissed / no action: lift an auto-flag once the queue for this song is
    // empty, so a song is not left unavailable by reports found to be invalid.
    const stillPending = await this.countPendingForSong(songId);
    if (stillPending === 0 && song.flagged && song.flaggedBy === null) {
      song.flagged = false;
      song.flaggedAt = null;
      song.flagReason = null;
      await this.songRepo.save(song);
      await CacheService.clearSong(songId);
    }
  }

  private parseReason(raw: string): ReportReason {
    const value = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (!VALID_REASONS.includes(value as ReportReason)) {
      throw AppError.validation(
        `reason must be one of: ${VALID_REASONS.join(', ')}`,
        { field: 'reason', value: raw },
        'INVALID_REPORT_REASON',
      );
    }
    return value as ReportReason;
  }

  private parseAction(raw: string): ReportAction {
    const value = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (!VALID_ACTIONS.includes(value as ReportAction)) {
      throw AppError.validation(
        `actionTaken must be one of: ${VALID_ACTIONS.join(', ')}`,
        { field: 'actionTaken', value: raw },
        'INVALID_REPORT_ACTION',
      );
    }
    return value as ReportAction;
  }

  /**
   * Issue #273: Score report with AI for triage priority (advisory only).
   * Fails open: if AI call errors, report is still queued normally.
   */
  private async scoreReportWithAI(report: ContentReport, song: Song): Promise<void> {
    try {
      const provider = getAiProvider();
      // Fence user-supplied text so it cannot be read as instructions (#282).
      const result = await provider.scoreContentReport({
        reportId: report.id,
        contentType: 'song',
        contentText: delimitUserContent(`${song.title} - ${song.description || ''}`),
        reportReason: report.reason,
        reporterContext: delimitUserContent(report.description || ''),
      });

      report.aiSeverityScore = result.severityScore;
      report.aiSuggestedPriority = result.suggestedPriority;
      report.aiCategories = result.categories;
      report.aiReasoning = result.reasoning;
      report.aiProvider = result.provider;

      await this.reportRepo.save(report);

      logger.info(
        {
          reportId: report.id,
          songId: report.songId,
          aiScore: result.severityScore,
          aiPriority: result.suggestedPriority,
        },
        'AI content moderation scoring completed',
      );
    } catch (error) {
      // Fail open: log error but don't block report submission
      logger.warn(
        { reportId: report.id, songId: report.songId, error },
        'AI content moderation scoring failed, proceeding without AI score',
      );
    }
  }
}
