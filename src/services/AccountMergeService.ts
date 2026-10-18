import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { User } from '../entities/User';
import { AppError } from '../errors/AppError';
import logger from '../config/logger';
import { AuthAuditService } from './AuthAuditService';
import { AuthEventType } from '../entities/AuthAuditLog';
import { Request } from 'express';

export interface MergeResult {
  primaryUserId: string;
  mergedUserId: string;
  mergedFields: string[];
}

export class AccountMergeService {
  private userRepo: Repository<User>;
  private auditService: AuthAuditService;

  constructor() {
    this.userRepo = AppDataSource.getRepository(User);
    this.auditService = new AuthAuditService();
  }

  /**
   * Detect potential duplicate accounts that could be merged.
   * Returns accounts matching by email, wallet address, or Privy ID.
   */
  async detectDuplicates(userId: string): Promise<User[]> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    const duplicates: User[] = [];

    // Find by email (if user has one and it's verified)
    if (user.email && user.emailVerified) {
      const emailMatches = await this.userRepo
        .createQueryBuilder('u')
        .where('u.email = :email', { email: user.email })
        .andWhere('u.id != :userId', { userId })
        .andWhere('u.deletedAt IS NULL')
        .getMany();
      duplicates.push(...emailMatches);
    }

    // Find by wallet address
    if (user.walletAddress) {
      const walletMatches = await this.userRepo
        .createQueryBuilder('u')
        .where('u.walletAddress = :walletAddress', { walletAddress: user.walletAddress })
        .andWhere('u.id != :userId', { userId })
        .andWhere('u.deletedAt IS NULL')
        .getMany();
      duplicates.push(...walletMatches);
    }

    return duplicates;
  }

  async mergeAccounts(
    primaryUserId: string,
    secondaryUserId: string,
    req: Request,
  ): Promise<MergeResult> {
    if (primaryUserId === secondaryUserId) {
      throw AppError.validation('Cannot merge an account with itself');
    }

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const primaryUser = await queryRunner.manager.findOne(User, {
        where: { id: primaryUserId },
      });
      const secondaryUser = await queryRunner.manager.findOne(User, {
        where: { id: secondaryUserId },
      });

      if (!primaryUser) {
        throw AppError.notFound('Primary user not found');
      }
      if (!secondaryUser) {
        throw AppError.notFound('Secondary user not found');
      }
      if (secondaryUser.deletedAt) {
        throw AppError.validation('Cannot merge a deleted account');
      }

      const mergedFields: string[] = [];

      // Merge Privy ID if primary doesn't have one
      if (!primaryUser.privyUserId && secondaryUser.privyUserId) {
        primaryUser.privyUserId = secondaryUser.privyUserId;
        mergedFields.push('privyUserId');
      }

      // Merge wallet address if primary doesn't have one
      if (!primaryUser.walletAddress && secondaryUser.walletAddress) {
        primaryUser.walletAddress = secondaryUser.walletAddress;
        mergedFields.push('walletAddress');
      }

      // Merge email if primary doesn't have one (and secondary's is verified)
      if (!primaryUser.email && secondaryUser.email && secondaryUser.emailVerified) {
        primaryUser.email = secondaryUser.email;
        primaryUser.emailVerified = true;
        mergedFields.push('email');
      }

      // Merge Stellar wallet if primary doesn't have one
      if (!primaryUser.stellarPublicKey && secondaryUser.stellarPublicKey) {
        primaryUser.stellarPublicKey = secondaryUser.stellarPublicKey;
        primaryUser.stellarArtistId = secondaryUser.stellarArtistId;
        primaryUser.stellarArtistTokenId = secondaryUser.stellarArtistTokenId;
        mergedFields.push('stellarPublicKey');
      }

      // Merge social connections if primary doesn't have them
      if (!primaryUser.twitterConnected && secondaryUser.twitterConnected) {
        primaryUser.twitterId = secondaryUser.twitterId;
        primaryUser.twitterUsername = secondaryUser.twitterUsername;
        primaryUser.twitterDisplayName = secondaryUser.twitterDisplayName;
        primaryUser.twitterProfileImage = secondaryUser.twitterProfileImage;
        primaryUser.twitterVerified = secondaryUser.twitterVerified;
        primaryUser.twitterConnected = true;
        mergedFields.push('twitter');
      }

      if (!primaryUser.facebookConnected && secondaryUser.facebookConnected) {
        primaryUser.facebookId = secondaryUser.facebookId;
        primaryUser.facebookName = secondaryUser.facebookName;
        primaryUser.facebookEmail = secondaryUser.facebookEmail;
        primaryUser.facebookProfileImage = secondaryUser.facebookProfileImage;
        primaryUser.facebookConnected = true;
        mergedFields.push('facebook');
      }

      // Aggregate stats
      primaryUser.rewardPoints += secondaryUser.rewardPoints;

      // Mark secondary account for deletion
      secondaryUser.deletionRequestedAt = new Date();
      secondaryUser.deletionScheduledFor = new Date();
      secondaryUser.deletionReason = `Merged into account ${primaryUserId}`;

      await queryRunner.manager.save(User, primaryUser);
      await queryRunner.manager.save(User, secondaryUser);

      await queryRunner.commitTransaction();

      // Audit log the merge
      await this.auditService.logAuthEvent(AuthEventType.ACCOUNT_MERGED, req, {
        userId: primaryUserId,
        success: true,
        metadata: {
          secondaryUserId,
          mergedFields,
          secondaryEmail: secondaryUser.email,
          secondaryWallet: secondaryUser.walletAddress,
        },
      });

      logger.info(
        {
          primaryUserId,
          secondaryUserId,
          mergedFields,
        },
        'Accounts merged successfully',
      );

      return {
        primaryUserId,
        mergedUserId: secondaryUserId,
        mergedFields,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      logger.error({ error, primaryUserId, secondaryUserId }, 'Account merge failed');
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Automatically merge duplicate accounts created during Privy login
   * if they match by verified email or wallet address.
   */
  async autoMergeDuringLogin(
    privyUserId: string,
    email: string | null,
    walletAddress: string | null,
    req: Request,
  ): Promise<User | null> {
    // Look for existing user by Privy ID
    let existingUser = await this.userRepo.findOne({ where: { privyUserId } });
    if (existingUser) {
      return existingUser; // Already linked, no merge needed
    }

    // Look for existing user by verified email
    if (email) {
      const emailUser = await this.userRepo.findOne({
        where: { email, emailVerified: true },
      });
      if (emailUser && !emailUser.privyUserId && !emailUser.deletedAt) {
        // Link the Privy ID to this existing account
        emailUser.privyUserId = privyUserId;
        await this.userRepo.save(emailUser);

        await this.auditService.logAuthEvent(AuthEventType.ACCOUNT_MERGED, req, {
          userId: emailUser.id,
          privyUserId,
          success: true,
          metadata: {
            mergeType: 'auto_link_email',
            email,
          },
        });

        logger.info(
          { userId: emailUser.id, privyUserId, email },
          'Auto-linked existing email account with Privy',
        );

        return emailUser;
      }
    }

    // Look for existing user by wallet address
    if (walletAddress) {
      const walletUser = await this.userRepo.findOne({ where: { walletAddress } });
      if (walletUser && !walletUser.privyUserId && !walletUser.deletedAt) {
        // Link the Privy ID to this existing account
        walletUser.privyUserId = privyUserId;
        await this.userRepo.save(walletUser);

        await this.auditService.logAuthEvent(AuthEventType.ACCOUNT_MERGED, req, {
          userId: walletUser.id,
          privyUserId,
          success: true,
          metadata: {
            mergeType: 'auto_link_wallet',
            walletAddress,
          },
        });

        logger.info(
          { userId: walletUser.id, privyUserId, walletAddress },
          'Auto-linked existing wallet account with Privy',
        );

        return walletUser;
      }
    }

    return null; // No existing account found, proceed with new user creation
  }
}
