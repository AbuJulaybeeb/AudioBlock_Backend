import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import {
  SongCollaborator,
  CollaboratorRole,
  CollaboratorStatus,
} from '../entities/SongCollaborator';
import { AppError } from '../errors/AppError';
import { NotificationService } from './NotificationService';
import logger from '../config/logger';

export interface AddCollaboratorInput {
  userId: string;
  role: CollaboratorRole;
  royaltyShare: number;
}

const SHARE_TOTAL_TOLERANCE = 0.01;

/**
 * Manages per-song collaborator credits and royalty splits. The primary
 * artist (song.artistId) is the only one authorized to add/update/remove
 * collaborators; total royalty shares across active collaborators must
 * never exceed 100.
 */
export class CollaborationService {
  private songRepo: Repository<Song>;
  private collaboratorRepo: Repository<SongCollaborator>;
  private notificationService: NotificationService;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
    this.collaboratorRepo = AppDataSource.getRepository(SongCollaborator);
    this.notificationService = new NotificationService();
  }

  private async getSongOrThrow(songId: string): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw AppError.notFound('Song not found');
    return song;
  }

  private assertIsPrimaryArtist(song: Song, userId: string): void {
    if (song.artistId !== userId) {
      throw AppError.authorization('Only the primary artist can manage collaborators');
    }
  }

  /** Splits are written on-chain at mint time, so they are frozen once minting starts. */
  private assertNotMinted(song: Song): void {
    if (song.mintStatus === 'pending' || song.mintStatus === 'minted') {
      throw AppError.conflict('Collaborators cannot be changed after the song is minted');
    }
  }

  async listCollaborators(songId: string): Promise<SongCollaborator[]> {
    await this.getSongOrThrow(songId);
    return this.collaboratorRepo.find({
      where: { songId, status: CollaboratorStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });
  }

  async addCollaborator(
    songId: string,
    requesterId: string,
    input: AddCollaboratorInput,
  ): Promise<SongCollaborator> {
    const song = await this.getSongOrThrow(songId);
    this.assertIsPrimaryArtist(song, requesterId);
    this.assertNotMinted(song);

    if (!Object.values(CollaboratorRole).includes(input.role)) {
      throw AppError.validation(
        `role must be one of: ${Object.values(CollaboratorRole).join(', ')}`,
      );
    }

    const existing = await this.collaboratorRepo.findOneBy({ songId, userId: input.userId });
    if (existing && existing.status === CollaboratorStatus.ACTIVE) {
      throw AppError.conflict('This user is already a collaborator on this song');
    }

    const others = await this.listCollaborators(songId);
    await this.assertSharesWithin100([...others.map((c) => c.royaltyShare), input.royaltyShare]);

    const collaborator =
      existing ??
      this.collaboratorRepo.create({
        songId,
        userId: input.userId,
      });

    collaborator.role = input.role;
    collaborator.royaltyShare = input.royaltyShare;
    collaborator.status = CollaboratorStatus.ACTIVE;

    const saved = await this.collaboratorRepo.save(collaborator);

    try {
      await this.notificationService.create({
        userId: input.userId,
        type: 'system',
        title: 'Added as a collaborator',
        message: `You were added as ${input.role} on "${song.title}" with a ${input.royaltyShare}% royalty share.`,
        data: { songId, role: input.role, royaltyShare: input.royaltyShare },
      });
    } catch (err) {
      logger.warn({ songId, userId: input.userId, err }, 'Failed to notify added collaborator');
    }

    return saved;
  }

  async updateCollaborator(
    songId: string,
    targetUserId: string,
    requesterId: string,
    updates: Partial<Pick<AddCollaboratorInput, 'role' | 'royaltyShare'>>,
  ): Promise<SongCollaborator> {
    const song = await this.getSongOrThrow(songId);
    this.assertIsPrimaryArtist(song, requesterId);
    this.assertNotMinted(song);

    const collaborator = await this.collaboratorRepo.findOneBy({
      songId,
      userId: targetUserId,
      status: CollaboratorStatus.ACTIVE,
    });
    if (!collaborator) throw AppError.notFound('Collaborator not found on this song');

    if (updates.role !== undefined) {
      if (!Object.values(CollaboratorRole).includes(updates.role)) {
        throw AppError.validation(
          `role must be one of: ${Object.values(CollaboratorRole).join(', ')}`,
        );
      }
      collaborator.role = updates.role;
    }

    if (updates.royaltyShare !== undefined) {
      const others = await this.listCollaborators(songId);
      const shares = others
        .filter((c) => c.userId !== targetUserId)
        .map((c) => c.royaltyShare)
        .concat(updates.royaltyShare);
      await this.assertSharesWithin100(shares);
      collaborator.royaltyShare = updates.royaltyShare;
    }

    return this.collaboratorRepo.save(collaborator);
  }

  private async assertSharesWithin100(shares: number[]): Promise<void> {
    const total = shares.reduce((sum, share) => sum + share, 0);
    if (total > 100 + SHARE_TOTAL_TOLERANCE) {
      throw AppError.validation(`Total royalty shares cannot exceed 100% (got ${total}%)`);
    }
  }

  async disputeSplit(songId: string, requesterId: string): Promise<SongCollaborator> {
    const song = await this.getSongOrThrow(songId);

    // Any collaborator can dispute
    const collaborator = await this.collaboratorRepo.findOneBy({
      songId,
      userId: requesterId,
      status: CollaboratorStatus.ACTIVE,
    });

    if (!collaborator) {
      throw AppError.authorization('Only active collaborators can dispute splits');
    }

    collaborator.disputeStatus = (
      await import('../entities/SongCollaborator')
    ).DisputeStatus.DISPUTED;
    return this.collaboratorRepo.save(collaborator);
  }

  async resolveDispute(
    songId: string,
    targetUserId: string,
    requesterId: string,
  ): Promise<SongCollaborator> {
    const song = await this.getSongOrThrow(songId);

    // Only primary artist can resolve for now
    this.assertIsPrimaryArtist(song, requesterId);

    const collaborator = await this.collaboratorRepo.findOneBy({
      songId,
      userId: targetUserId,
      status: CollaboratorStatus.ACTIVE,
    });

    if (!collaborator) {
      throw AppError.notFound('Collaborator not found');
    }

    collaborator.disputeStatus = (
      await import('../entities/SongCollaborator')
    ).DisputeStatus.RESOLVED;
    return this.collaboratorRepo.save(collaborator);
  }
}
