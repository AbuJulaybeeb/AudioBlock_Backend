import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { User, UserRole } from '../entities/User';
import { AppError } from '../errors/AppError';
import logger from '../config/logger';

/**
 * Service for managing artist vs listener account type distinction (Issue #616).
 *
 * Handles the logic for:
 * - Setting account type during signup
 * - Upgrading from listener to artist
 * - Enforcing business rules around account types
 */
export class AccountTypeService {
  private userRepo: Repository<User>;

  constructor() {
    this.userRepo = AppDataSource.getRepository(User);
  }

  /**
   * Set account type for a user (Issue #616).
   *
   * @param userId - User ID
   * @param accountType - Role to set (artist or listener)
   * @param metadata - Additional metadata like artist name, bio
   * @returns Updated user entity
   */
  async setAccountType(
    userId: string,
    accountType: UserRole.ARTIST | UserRole.LISTENER,
    metadata?: {
      artistName?: string;
      bio?: string;
    },
  ): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    // Validate account type
    if (accountType !== UserRole.ARTIST && accountType !== UserRole.LISTENER) {
      throw AppError.validation('Invalid account type. Must be artist or listener.');
    }

    // Update user role
    user.role = accountType;

    // Update artist-specific metadata
    if (accountType === UserRole.ARTIST) {
      if (metadata?.artistName) {
        user.name = metadata.artistName;
      }
      if (metadata?.bio) {
        user.bio = metadata.bio;
      }

      logger.info({ userId, accountType }, 'User account type set to artist');
    } else {
      logger.info({ userId, accountType }, 'User account type set to listener');
    }

    return this.userRepo.save(user);
  }

  /**
   * Upgrade a listener account to artist (Issue #616).
   *
   * This is the primary way users become artists - they start as listeners
   * and upgrade when they want to upload content.
   *
   * @param userId - User ID
   * @param metadata - Artist profile information
   * @returns Updated user entity
   */
  async upgradeToArtist(
    userId: string,
    metadata?: {
      artistName?: string;
      bio?: string;
    },
  ): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    // Check if already an artist or higher
    if (
      user.role === UserRole.ARTIST ||
      user.role === UserRole.MODERATOR ||
      user.role === UserRole.ADMIN ||
      user.role === UserRole.SUPER_ADMIN
    ) {
      throw AppError.businessLogic('User already has artist privileges or higher');
    }

    // Upgrade to artist
    user.role = UserRole.ARTIST;

    if (metadata?.artistName) {
      user.name = metadata.artistName;
    }

    if (metadata?.bio) {
      user.bio = metadata.bio;
    }

    logger.info({ userId }, 'User upgraded from listener to artist');

    return this.userRepo.save(user);
  }

  /**
   * Get account type information for a user.
   *
   * @param userId - User ID
   * @returns User account type information
   */
  async getAccountType(userId: string): Promise<{
    id: string;
    role: UserRole;
    isArtist: boolean;
    isListener: boolean;
    canUploadContent: boolean;
    username?: string;
    name?: string;
    email?: string;
  }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    const isArtist =
      user.role === UserRole.ARTIST ||
      user.role === UserRole.MODERATOR ||
      user.role === UserRole.ADMIN ||
      user.role === UserRole.SUPER_ADMIN;

    const isListener = user.role === UserRole.LISTENER;

    // Artists and above can upload content
    const canUploadContent = isArtist;

    return {
      id: user.id,
      role: user.role,
      isArtist,
      isListener,
      canUploadContent,
      username: user.username,
      name: user.name,
      email: user.email,
    };
  }

  /**
   * Check if a user can perform artist actions (upload content, manage royalties, etc.).
   *
   * @param userId - User ID
   * @returns True if user has artist privileges
   */
  async canPerformArtistActions(userId: string): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      return false;
    }

    return (
      user.role === UserRole.ARTIST ||
      user.role === UserRole.MODERATOR ||
      user.role === UserRole.ADMIN ||
      user.role === UserRole.SUPER_ADMIN
    );
  }
}
