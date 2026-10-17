import { plainToInstance } from 'class-transformer';
import { Request, Response } from 'express';
import { validate } from 'class-validator';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import { RequestAccountDeletionDTO } from '../dtos/AccountDeletionDTO';
import { AccountDeletionService } from '../services/AccountDeletionService';
import { UpdateProfileDTO } from '../dtos/UpdateProfileDTO';
import { formatValidationErrors } from '../middlewares/validate';
import { Repository } from 'typeorm';
import { User } from '../entities/User';
import AppDataSource from '../config/db';
import { AccountMergeService } from '../services/AccountMergeService';

/**
 * Self-service account lifecycle endpoints (Issue #633).
 *
 * These are the user-facing side of GDPR Articles 12, 15, 17 and 20. Every route
 * is scoped to the *authenticated* user — there is no path parameter for a user
 * id, so none of these can be pointed at someone else's account by mistake or by
 * a crafted request.
 */
export class AccountController {
  private service: AccountDeletionService;
  private userRepo: Repository<User>;
  private mergeService: AccountMergeService;

  constructor(service: AccountDeletionService = new AccountDeletionService()) {
    this.service = service;
    this.userRepo = AppDataSource.getRepository(User);
    this.mergeService = new AccountMergeService();
  }

  /**
   * `GET /api/account/data` — full portability export of the caller's data
   * (Art. 15, 20). Deliberately a GET returning JSON: the caller chooses how to
   * store it, and streaming a file would pin a delivery format.
   */
  exportData = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const data = await this.service.exportUserData(userId);
      res.status(200).json({ success: true, data });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `POST /api/account/deletion-request` — schedule erasure after a grace window
   * (Art. 17). Returns the reference id and the scheduled date so the user knows
   * exactly when the irreversible step happens and can cancel before it.
   */
  requestDeletion = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const dto = plainToInstance(RequestAccountDeletionDTO, req.body ?? {}, {
        enableImplicitConversion: true,
      });
      const errors = await validate(dto);
      if (errors.length > 0) {
        throw AppError.validation('Validation failed', formatValidationErrors(errors));
      }

      if (dto.confirm !== true) {
        throw AppError.validation('Deletion must be explicitly confirmed: set "confirm" to true', {
          field: 'confirm',
        });
      }

      const result = await this.service.requestDeletion(userId, dto.reason);

      res.status(202).json({
        success: true,
        message:
          'Account deletion scheduled. Export your data before the scheduled date if you want a copy, ' +
          'and you can cancel any time before then.',
        ...result,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `DELETE /api/account/deletion-request` — cancel a pending request, restoring
   * normal access to the account.
   */
  cancelDeletion = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      await this.service.cancelDeletion(userId);
      res.status(200).json({ success: true, message: 'Account deletion request cancelled' });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** `GET /api/account/deletion-status` — where the request stands. */
  getDeletionStatus = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const status = await this.service.getStatus(userId);
      res.status(200).json({ success: true, ...status });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `GET /api/account/profile` — fetch current authenticated user's profile (Issue #617).
   * Returns full profile data for the authenticated user.
   */
  getProfile = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw AppError.notFound('User not found');
      }

      // Exclude sensitive fields
      const { passwordHash, twoFactorSecret, twoFactorRecoveryCodeHashes, ...profile } = user;

      res.status(200).json({ success: true, profile });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `PUT /api/account/profile` — update user profile after authentication (Issue #618).
   * Allows updating profile fields like username, bio, website, etc.
   */
  updateProfile = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const dto = plainToInstance(UpdateProfileDTO, req.body ?? {}, {
        enableImplicitConversion: true,
      });
      const errors = await validate(dto);
      if (errors.length > 0) {
        throw AppError.validation('Validation failed', formatValidationErrors(errors));
      }

      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw AppError.notFound('User not found');
      }

      // Check for unique constraint violations before updating
      if (dto.username && dto.username !== user.username) {
        const existingUser = await this.userRepo.findOne({ where: { username: dto.username } });
        if (existingUser) {
          throw AppError.conflict('Username already taken');
        }
      }

      // Update allowed fields
      if (dto.username !== undefined) user.username = dto.username;
      if (dto.name !== undefined) user.name = dto.name;
      if (dto.bio !== undefined) user.bio = dto.bio;
      if (dto.website !== undefined) user.website = dto.website;
      if (dto.profileImage !== undefined) user.profileImage = dto.profileImage;
      if (dto.pageCover !== undefined) user.pageCover = dto.pageCover;
      if (dto.isProfilePublic !== undefined) user.isProfilePublic = dto.isProfilePublic;

      await this.userRepo.save(user);

      const { passwordHash, twoFactorSecret, twoFactorRecoveryCodeHashes, ...profile } = user;

      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        profile,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `GET /api/account/duplicates` — detect potential duplicate accounts (Issue #619).
   * Returns accounts that could potentially be merged based on email/wallet matches.
   */
  detectDuplicates = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw AppError.authentication('Unauthorized');
      }

      const duplicates = await this.mergeService.detectDuplicates(userId);

      res.status(200).json({
        success: true,
        duplicates: duplicates.map((u) => ({
          id: u.id,
          email: u.email,
          walletAddress: u.walletAddress,
          privyUserId: u.privyUserId,
          username: u.username,
          createdAt: u.createdAt,
        })),
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * `POST /api/account/merge` — merge duplicate accounts (Issue #619).
   * Merges a secondary account into the primary (authenticated) account.
   */
  mergeAccounts = async (req: Request, res: Response) => {
    try {
      const primaryUserId = (req as any).user?.id;
      if (!primaryUserId) {
        throw AppError.authentication('Unauthorized');
      }

      const { secondaryUserId } = req.body;
      if (!secondaryUserId) {
        throw AppError.validation('secondaryUserId is required');
      }

      const result = await this.mergeService.mergeAccounts(primaryUserId, secondaryUserId, req);

      res.status(200).json({
        success: true,
        message: 'Accounts merged successfully',
        result,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
