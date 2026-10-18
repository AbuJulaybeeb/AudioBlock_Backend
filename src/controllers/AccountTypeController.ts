import { Request, Response } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrivyAccountTypeDTO } from '../dtos/PrivyAccountTypeDTO';
import { AccountTypeService } from '../services/AccountTypeService';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import logger from '../config/logger';

/**
 * Controller for managing artist vs listener account type distinction (Issue #616).
 *
 * Handles:
 * - Account type selection during signup
 * - Upgrading listener account to artist
 * - Viewing current account type
 */
export class AccountTypeController {
  private accountTypeService: AccountTypeService;

  constructor() {
    this.accountTypeService = new AccountTypeService();
  }

  /**
   * Set or update user account type (Issue #616).
   * Allows users to upgrade from listener to artist.
   */
  setAccountType = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user || (req as any).privyUser;

      if (!user || !user.id) {
        throw AppError.authentication('User authentication required');
      }

      const dto = plainToInstance(PrivyAccountTypeDTO, req.body);
      const errors = await validate(dto);

      if (errors.length > 0) {
        throw AppError.validation(
          'Validation failed',
          errors.map((err) => ({
            field: err.property,
            message: Object.values(err.constraints || {})[0] ?? 'Invalid value',
          })),
        );
      }

      const updatedUser = await this.accountTypeService.setAccountType(user.id, dto.accountType, {
        artistName: dto.artistName,
        bio: dto.bio,
      });

      res.status(200).json({
        success: true,
        message: 'Account type updated successfully',
        user: updatedUser,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * Get current user's account type.
   */
  getAccountType = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user || (req as any).privyUser;

      if (!user || !user.id) {
        throw AppError.authentication('User authentication required');
      }

      const accountInfo = await this.accountTypeService.getAccountType(user.id);

      res.status(200).json({
        success: true,
        accountType: accountInfo.role,
        isArtist: accountInfo.isArtist,
        isListener: accountInfo.isListener,
        canUploadContent: accountInfo.canUploadContent,
        user: {
          id: accountInfo.id,
          role: accountInfo.role,
          username: accountInfo.username,
          name: accountInfo.name,
          email: accountInfo.email,
        },
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /**
   * Upgrade listener account to artist (Issue #616).
   * This is a one-way operation - artists cannot downgrade to listeners.
   */
  upgradeToArtist = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user || (req as any).privyUser;

      if (!user || !user.id) {
        throw AppError.authentication('User authentication required');
      }

      const { artistName, bio } = req.body;

      const updatedUser = await this.accountTypeService.upgradeToArtist(user.id, {
        artistName,
        bio,
      });

      logger.info({ userId: user.id }, 'User upgraded to artist account');

      res.status(200).json({
        success: true,
        message: 'Account upgraded to artist successfully',
        user: {
          id: updatedUser.id,
          role: updatedUser.role,
          username: updatedUser.username,
          name: updatedUser.name,
          bio: updatedUser.bio,
        },
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
