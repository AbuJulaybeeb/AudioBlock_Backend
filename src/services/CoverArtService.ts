import { Repository } from 'typeorm';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import { PinataService } from './PinataService';
import { AppError } from '../errors/AppError';
import { validateFileContent } from '../utils/contentSniffing';
import logger from '../config/logger';

const THUMBNAIL_SIZES = [150, 300, 600];
const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'];

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * Album/song cover art upload and retrieval (Issue #80).
 *
 * The original image and its thumbnail variants (150px, 300px, 600px) are
 * pinned to IPFS via {@link PinataService}; the resulting CIDs are stored on
 * the Song entity so retrieval can serve gateway URLs for every variant.
 */
export class CoverArtService {
  private songRepo: Repository<Song>;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
  }

  /** Public Pinata gateway base used to build image URLs from CIDs. */
  private get gatewayBase(): string {
    const gateway = process.env.PINATA_GATEWAY || 'gateway.pinata.cloud';
    return `https://${gateway}/ipfs`;
  }

  /**
   * Validate, upload, and associate cover art with a song.
   *
   * @param songId - Song to associate the cover art with.
   * @param userId - Authenticated user; must own the song.
   * @param file   - Multer file (buffer + originalname + mimetype).
   * @returns The updated Song entity.
   * @throws AppError when the song is missing, the user is not the owner, or
   * the file format is unsupported.
   */
  async uploadCoverArt(songId: string, userId: string, file: Express.Multer.File): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }
    if (song.artistId !== userId) {
      throw AppError.authorization(
        'You can only update cover art for your own songs',
        undefined,
        'NOT_SONG_OWNER',
      );
    }

    const extension = EXTENSION_BY_MIMETYPE[file.mimetype];
    if (!extension) {
      throw AppError.validation(
        'Unsupported image format. Allowed formats: JPEG, PNG, WebP',
        undefined,
        'INVALID_IMAGE_FORMAT',
      );
    }

    // #350 — validate actual file content via magic bytes, not just the
    // client-declared mimetype or filename extension.
    try {
      validateFileContent(file.buffer, file.mimetype, ALLOWED_MIMETYPES);
    } catch (err) {
      throw AppError.validation(
        err instanceof Error ? err.message : 'Invalid file content',
        undefined,
        'INVALID_FILE_CONTENT',
      );
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-art-'));
    try {
      const originalPath = path.join(workDir, `original${extension}`);
      fs.writeFileSync(originalPath, file.buffer);

      const originalRes = await PinataService.uploadFile(
        originalPath,
        `${songId}-cover${extension}`,
      );

      const thumbnails: Record<string, string> = {};
      for (const size of THUMBNAIL_SIZES) {
        const thumbPath = path.join(workDir, `thumb-${size}${extension}`);
        await this.generateThumbnail(originalPath, thumbPath, size);
        const thumbRes = await PinataService.uploadFile(
          thumbPath,
          `${songId}-cover-${size}px${extension}`,
        );
        thumbnails[String(size)] = `${this.gatewayBase}/${thumbRes.cid}`;
      }

      song.coverArtIpfsHash = originalRes.cid;
      song.coverArtThumbnails = thumbnails;
      // Point coverArtPath at the pinned original so downstream flows (e.g.
      // the SongProcessorWorker metadata step) use the new artwork.
      song.coverArtPath = `${this.gatewayBase}/${originalRes.cid}`;

      logger.info({ songId, cid: originalRes.cid }, 'Cover art uploaded and pinned');
      return this.songRepo.save(song);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Return the cover art (original + thumbnails) for a song.
   */
  async getCoverArt(songId: string): Promise<{
    songId: string;
    coverArtPath: string | null;
    coverArtIpfsHash: string | null;
    thumbnails: Record<string, string> | null;
  }> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }

    return {
      songId: song.id,
      coverArtPath: song.coverArtPath || null,
      coverArtIpfsHash: song.coverArtIpfsHash || null,
      thumbnails: song.coverArtThumbnails ?? null,
    };
  }

  /**
   * Resize an image to a fixed width, preserving aspect ratio, via ffmpeg.
   */
  private generateThumbnail(inputPath: string, outputPath: string, width: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([`-vf`, `scale=${width}:-2`])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
  }
}
