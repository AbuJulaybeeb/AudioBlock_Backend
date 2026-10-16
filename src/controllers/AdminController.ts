import { Request, Response } from 'express';
import { UserService } from '../services/UserService';
import { ArtistProfileService } from '../services/ArtistProfileService';
import { CommentReportService } from '../services/CommentReportService';
import { ReportService } from '../services/ReportService';
import { ResolveReportDTO } from '../dtos/ReportSongDTO';
import { ResolveCommentReportDTO } from '../dtos/ReportCommentDTO';
import { handleError } from '../utils/helpers';
import { HTTP_STATUS } from '../config/constants';
import { AppError } from '../errors/AppError';
import { routeParam } from '../utils/routeParams';
import { VerificationStatus } from '../entities/ArtistVerification';
import { TransactionLogService } from '../services/TransactionLogService';
import { IndexerService } from '../services/IndexerService';
import { SongModerationService } from '../services/Song/SongModerationService';
import { AiUsageService } from '../services/ai/AiUsageService';

const MAX_AI_USAGE_ARTISTS = 200;

/** Parses an optional ISO date query param, rejecting anything unparseable. */
function parseDateParam(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation(`${field} must be an ISO 8601 date`, { field, value });
  }
  return date;
}

/**
 * Admin-facing user & role management (Issue #100) and artist verification
 * review (Issue #92).
 */
export class AdminController {
  private static userService = new UserService();
  private static artistProfileService = new ArtistProfileService();
  private static transactionLogService = new TransactionLogService();
  private static reportService = new ReportService();
  private static commentReportService = new CommentReportService();
  private static indexerService = new IndexerService();
  private static aiUsageService = new AiUsageService();

  /**
   * GET /api/admin/reports — list the pending content-report moderation queue
   * (song and comment reports, Issue #88 / #411).
   */
  static listReports = async (req: Request, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const songId = typeof req.query.songId === 'string' ? req.query.songId : undefined;

      const songReports = await AdminController.reportService.listPendingReports(
        page,
        limit,
        songId,
      );
      const commentReports = await AdminController.commentReportService.listPendingReports(
        page,
        limit,
      );

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        songReports,
        commentReports,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * POST /api/admin/songs/moderate — apply a moderation action to a batch of
   * songs (Issue #85). The route enforces permission, rate limiting, and DTO
   * validation; each song outcome is reported individually so partial failures
   * are visible to the caller.
   */
  static bulkModerateSongs = async (req: Request, res: Response) => {
    try {
      const adminId = (req as any).user?.id;

      if (!adminId) {
        return handleError(req, res, AppError.authentication('Moderator not authenticated'));
      }

      const { songIds, action } = req.body;
      const moderationService = new SongModerationService();
      const result = await moderationService.bulkModerate(songIds, action, adminId);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        ...result,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * PUT /api/admin/reports/:id/resolve — resolve a song content report
   * (Issue #88).
   */
  static resolveReport = async (req: Request, res: Response) => {
    try {
      const moderatorId = (req as any).user?.id;

      if (!moderatorId) {
        return handleError(req, res, AppError.authentication('Moderator not authenticated'));
      }

      const report = await AdminController.reportService.resolveReport(
        routeParam(req.params.id),
        moderatorId,
        req.body as ResolveReportDTO,
      );

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Report resolved',
        report,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/comment-reports — list pending comment reports with comment
   * context (Issue #411).
   */
  static listCommentReports = async (req: Request, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const result = await AdminController.commentReportService.listPendingReports(page, limit);
      return res.status(HTTP_STATUS.OK).json({ success: true, ...result });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * PUT /api/admin/comment-reports/:id/resolve — resolve a comment report and
   * flag the comment (Issue #411).
   */
  static resolveCommentReport = async (req: Request, res: Response) => {
    try {
      const moderatorId = (req as any).user?.id;

      if (!moderatorId) {
        return handleError(req, res, AppError.authentication('Moderator not authenticated'));
      }

      const report = await AdminController.commentReportService.resolveReport(
        routeParam(req.params.id),
        moderatorId,
        req.body as ResolveCommentReportDTO,
      );

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Comment report resolved',
        report,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * POST /api/admin/users/:id/role — assign a role to a user.
   *
   * Authorization is enforced by the route (admin-only). The request body is
   * validated against {@link AssignRoleDTO} so `role` is always a valid
   * {@link UserRole}.
   */
  static assignRole = async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { role } = req.body;

      const user = await AdminController.userService.assignRole(id, role);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Role assigned successfully',
        id: user.id,
        role: user.role,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/verifications — list verification applications (Issue #92).
   *
   * Defaults to the pending queue; `?status=approved|rejected` inspects history.
   */
  static listVerifications = async (req: Request, res: Response) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;

      if (
        statusParam &&
        !Object.values(VerificationStatus).includes(statusParam as VerificationStatus)
      ) {
        return handleError(
          req,
          res,
          AppError.validation(
            `status must be one of: ${Object.values(VerificationStatus).join(', ')}`,
            { field: 'status', value: statusParam },
          ),
        );
      }

      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;

      const result = await AdminController.artistProfileService.listVerifications(
        (statusParam as VerificationStatus) ?? VerificationStatus.PENDING,
        page,
        limit,
      );

      return res.status(HTTP_STATUS.OK).json(result);
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * PUT /api/admin/verifications/:id/approve — grant a verification badge
   * (Issue #92).
   */
  static approveVerification = async (req: Request, res: Response) => {
    try {
      const adminId = (req as any).user?.id;

      if (!adminId) {
        return handleError(req, res, AppError.authentication('Admin not authenticated'));
      }

      const verification = await AdminController.artistProfileService.approveVerification(
        routeParam(req.params.id),
        adminId,
      );

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Verification approved successfully',
        verification,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * PUT /api/admin/verifications/:id/reject — decline an application with a
   * reason the applicant can act on (Issue #92).
   */
  static rejectVerification = async (req: Request, res: Response) => {
    try {
      const adminId = (req as any).user?.id;

      if (!adminId) {
        return handleError(req, res, AppError.authentication('Admin not authenticated'));
      }

      const verification = await AdminController.artistProfileService.rejectVerification(
        routeParam(req.params.id),
        adminId,
        req.body.reason,
      );

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Verification rejected',
        verification,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/transaction-logs — list transaction logs (Issue #39).
   */
  static getTransactionLogs = async (req: Request, res: Response) => {
    try {
      const filters = {
        userId: req.query.userId as string,
        status: req.query.status as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 50,
      };

      const result = await AdminController.transactionLogService.getAdminLogs(filters);

      return res.status(HTTP_STATUS.OK).json(result);
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/indexer/status — get indexer health per contract/network (Issue #253).
   *
   * Returns cursor position, lag, event count, and last error for all contracts.
   * Admin-gated via requirePermission middleware.
   */
  static getIndexerStatus = async (req: Request, res: Response) => {
    try {
      const currentLedgerParam = req.query.currentLedger as string | undefined;
      const currentLedger = currentLedgerParam ? Number(currentLedgerParam) : undefined;

      const statuses = await AdminController.indexerService.getAllStatus(currentLedger);
      const backfillStatuses = await AdminController.indexerService.getAllBackfillStatus();

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        indexers: statuses,
        backfills: backfillStatuses,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/ai/usage — platform-wide AI feature usage aggregated by
   * feature and by artist (Issue #289). Optional `from` / `to` (ISO dates)
   * bound the window; `limit` caps the per-artist list (default 50, max 200).
   */
  static getAiUsage = async (req: Request, res: Response) => {
    try {
      const from = parseDateParam(req.query.from, 'from');
      const to = parseDateParam(req.query.to, 'to');
      if (from && to && from > to) {
        throw AppError.validation('from must be before to', { field: 'from' });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_AI_USAGE_ARTISTS);

      const usage = await AdminController.aiUsageService.getUsageSummary({
        from,
        to,
        artistLimit: limit,
      });

      return res.status(HTTP_STATUS.OK).json({ success: true, data: usage });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * GET /api/admin/users/:id/linked-accounts — view Privy linked accounts for a user (Issue #632).
   *
   * Returns all authentication methods linked to the user's Privy account:
   * wallets, emails, social providers, etc. Requires admin permission.
   * Returns 404 if user has no Privy identity linked.
   */
  static getLinkedAccounts = async (req: Request, res: Response) => {
    try {
      const userId = routeParam(req.params.id);

      // Get user and their Privy ID
      const user = await AdminController.userService.findById(userId);
      if (!user) {
        return handleError(req, res, AppError.notFound('User not found'));
      }

      if (!user.privyUserId) {
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          message: 'User has no Privy account linked',
          userId: user.id,
          privyUserId: null,
          linkedAccounts: [],
        });
      }

      // Fetch linked accounts from Privy API
      const { privyService } = await import('../services/PrivyService');
      const privyUserData = await privyService.getUserData(user.privyUserId);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        userId: user.id,
        email: user.email,
        privyUserId: user.privyUserId,
        linkedAccounts: privyUserData.linked_accounts || [],
        mfaEnabled: privyUserData.mfa_methods?.length > 0,
        createdAt: privyUserData.created_at,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
