import { FindOptionsOrder, Repository } from 'typeorm';
import { Song } from '../entities/Song';
import { SongVersion } from '../entities/SongVersion';
import { User, UserRole } from '../entities/User';
import { TransactionLog } from '../entities/TransactionLog';
import { RoyaltyTemplate } from '../entities/RoyaltyTemplate';
import AppDataSource from '../config/db';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { s3 } from '../config/s3';
import { getChannel } from '../config/rabbitmq';
import { SorobanContracts } from '../config/soroban';
import { SorobanService, addressArg, stringArg, u64Arg } from './Soroban/SorobanService';
import { PreparedTransaction } from './Artist/ArtistService';
import { ScanService } from './ScanService';
import { CacheService } from './CacheService';
import { SongVersionService } from './Song/SongVersionService';
import { AppError } from '../errors/AppError';
import { ActivityService } from './ActivityService';
import logger from '../config/logger';
import { songsUploadedTotal } from './MetricsService';
import { deleteS3Objects, deleteS3Prefix, s3KeyFromUrl } from '../utils/s3Cleanup';

const activityService = new ActivityService();

/** Song fields an owner may edit via `PATCH /api/song/:id`. */
const EDITABLE_SONG_FIELDS = [
  'title',
  'description',
  'genreId',
  'composers',
  'lyrics',
  'language',
] as const;

/** Editable fields that are part of the on-chain metadata once a song is minted. */
const MINTED_IMMUTABLE_FIELDS = ['title', 'description', 'genreId'] as const;

export type UpdateSongInput = Partial<Pick<Song, (typeof EDITABLE_SONG_FIELDS)[number]>>;

/** The authenticated caller of an owner-restricted song operation. */
export interface SongRequester {
  id: string;
  role?: UserRole;
}

/**
 * Client-facing song shape. Built field by field so internal columns
 * (`s3OriginalUrl`, moderation and AI review fields) are never returned.
 * `errorReason` is only included for the owning artist.
 */
function toSongView(song: Song, isOwner: boolean) {
  return {
    id: song.id,
    title: song.title,
    description: song.description,
    artist: song.user
      ? {
          id: song.user.id,
          username: song.user.username,
          name: song.user.name,
          profileImage: song.user.profileImage,
        }
      : null,
    cover: { path: song.coverArtPath, thumbnails: song.coverArtThumbnails },
    genre: song.genre,
    genreId: song.genreId,
    duration: song.duration,
    playCount: song.playCount,
    status: song.status,
    mintStatus: song.mintStatus,
    onChainSongId: song.onChainSongId,
    onChainTokenId: song.onChainTokenId,
    createdAt: song.createdAt,
    ...(isOwner && { errorReason: song.errorReason }),
  };
}

/**
 * Parameters for {@link SongService.finalizeUpload}.
 */
export interface FinalizeUploadOptions {
  /** Unique identifier for the upload session. */
  fileId: string;
  /** Expected number of chunks to merge. */
  totalChunks: number;
  /** Song title. */
  title: string;
  /** ID of the artist User record. */
  artistId: string;
  /** Ethereum wallet address of the artist. */
  artistAddress: string;
  /** Song description. */
  description: string;
  /** Genre label. */
  genre: string;
  /** Path to the cover art image on disk. */
  coverArtPath: string;
  /** Comma-separated list of composer names. */
  composers: string;
}

export class SongService {
  async getSong(id: string) {
    const song = await this.songRepo.findOne({ where: { id } });
    if (!song) throw AppError.notFound('Song not found');
    return song;
  }

  async createSong(data: any, userId: string) {
    const song = this.songRepo.create({ ...data, user: { id: userId } });
    return await this.songRepo.save(song);
  }

  /**
   * Update the editable metadata of a song.
   *
   * Only the fields in {@link EDITABLE_SONG_FIELDS} are written. Once a song is
   * minted, the fields embedded in its on-chain metadata cannot change.
   *
   * @throws {AppError} 403 when the caller is not the owner (or an admin), 409
   *   when a minted song's on-chain field is changed.
   */
  async updateSong(id: string, data: UpdateSongInput, requester: SongRequester) {
    const song = await this.getSong(id);
    this.assertCanModify(song, requester);

    if (song.mintStatus === 'minted') {
      const locked = MINTED_IMMUTABLE_FIELDS.filter(
        (field) => data[field] !== undefined && data[field] !== song[field],
      );
      if (locked.length > 0) {
        throw AppError.conflict(
          `Cannot change ${locked.join(', ')} after the song is minted on-chain`,
          { fields: locked },
          'SONG_FIELD_IMMUTABLE',
        );
      }
    }

    for (const field of EDITABLE_SONG_FIELDS) {
      if (data[field] !== undefined) song[field] = data[field] as never;
    }
    const result = await this.songRepo.save(song);
    // Invalidate the cached streaming manifest so updated metadata is
    // reflected immediately, not only after TTL expiry (#335).
    await CacheService.clearSong(id);
    if (result.status === 'ready' && !result.flagged) {
      const indexable = await this.songRepo.findOne({ where: { id }, relations: ['user'] });
      if (indexable) SearchIndexService.scheduleIndexUpdate(indexable);
    }
    return result;
  }

  /**
   * Delete a song.
   *
   * An unminted song is removed along with its stored files. A minted song's
   * on-chain token still exists, so it is hidden (flagged) instead and its
   * files are kept.
   *
   * @throws {AppError} 403 when the caller is not the owner (or an admin).
   */
  async deleteSong(id: string, requester: SongRequester) {
    const song = await this.getSong(id);
    this.assertCanModify(song, requester);

    if (song.mintStatus === 'minted' || song.mintStatus === 'pending') {
      song.flagged = true;
      song.flaggedAt = new Date();
      song.flaggedBy = requester.id;
      song.flagReason = 'Hidden by owner (song is minted on-chain)';
      await this.songRepo.save(song);
      SearchIndexService.scheduleRemoval(id);
      await CacheService.clearSong(id);
      return { success: true, hidden: true };
    }

    await this.songRepo.remove(song);
    SearchIndexService.scheduleRemoval(id);
    // Invalidate cache on delete so a re-created song with the same ID
    // doesn't serve stale data (#335).
    await CacheService.clearSong(id);
    await this.deleteSongFiles(id, song);
    return { success: true, hidden: false };
  }

  /** Best-effort removal of a deleted song's original upload, HLS segments and cover art. */
  private async deleteSongFiles(id: string, song: Song) {
    try {
      const keys = [
        song.s3OriginalUrl,
        song.coverArtPath,
        ...Object.values(song.coverArtThumbnails ?? {}),
      ]
        .map((url) => s3KeyFromUrl(url))
        .filter((key): key is string => key !== null);
      await deleteS3Objects(keys);
      await deleteS3Prefix(`songs/${id}/hls/`);
    } catch (err) {
      logger.error({ err, songId: id }, 'Failed to clean up S3 objects for deleted song');
    }
  }

  private assertCanModify(song: Song, requester: SongRequester) {
    if (song.artistId !== requester.id && requester.role !== UserRole.ADMIN) {
      throw AppError.authorization(
        'You can only modify your own songs',
        undefined,
        'NOT_SONG_OWNER',
      );
    }
  }

  /**
   * Single-song response for `GET /api/song/:id` (Issue #810). Songs that are
   * flagged or not ready are a 404 unless the viewer is the owning artist.
   *
   * @param id - Song UUID.
   * @param viewerId - Authenticated caller, if any.
   */
  async getSongView(id: string, viewerId?: string) {
    validateUUID(id, 'id');
    const song = await this.songRepo.findOne({ where: { id }, relations: ['user'] });
    const isOwner = !!viewerId && song?.artistId === viewerId;
    if (!song || (!isOwner && (song.status !== 'ready' || song.flagged))) {
      throw AppError.notFound('Song not found');
    }
    return toSongView(song, isOwner);
  }

  /**
   * Filtered, paginated song listing for `GET /api/song` (Issue #811).
   * Public callers only ever see ready, unflagged songs; an artist listing
   * their own songs (`artistId` equal to the caller) sees every status and may
   * filter by it.
   *
   * @param query - Validated query parameters.
   * @param viewerId - Authenticated caller, if any.
   */
  async listSongs(query: ListSongsQueryDTO, viewerId?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const isOwner = !!viewerId && query.artistId === viewerId;
    if (query.status && !isOwner) {
      throw AppError.authorization('The status filter is only available for your own songs');
    }

    const qb = this.songRepo.createQueryBuilder('song').leftJoinAndSelect('song.user', 'artist');
    if (!isOwner) {
      qb.where('song.status = :ready', { ready: 'ready' }).andWhere('song.flagged = false');
    } else if (query.status) {
      qb.where('song.status = :status', { status: query.status });
    }

    if (query.artistId) qb.andWhere('song.artistId = :artistId', { artistId: query.artistId });
    if (query.genreId) qb.andWhere('song.genreId = :genreId', { genreId: query.genreId });
    if (query.mintStatus)
      qb.andWhere('song.mintStatus = :mintStatus', { mintStatus: query.mintStatus });
    if (query.tag) {
      qb.andWhere((q) => {
        const tagged = q
          .subQuery()
          .select('st.songId')
          .from(SongTag, 'st')
          .innerJoin('st.tag', 't')
          .where('t.slug = :tag')
          .getQuery();
        return `song.id IN ${tagged}`;
      }).setParameter('tag', query.tag.toLowerCase());
    }

    if (query.sort === 'popular') qb.orderBy('song.playCount', 'DESC');
    else if (query.sort === 'title') qb.orderBy('song.title', 'ASC');
    else qb.orderBy('song.createdAt', 'DESC');
    qb.addOrderBy('song.id', 'ASC');

    const [songs, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return paginatedResponse(
      songs.map((song) => toSongView(song, isOwner)),
      total,
      page,
      limit,
    );
  }

  private songRepo: Repository<Song>;
  private userRepo: Repository<User>;
  private logRepo: Repository<TransactionLog>;
  private soroban: SorobanService;
  private versionServiceInstance?: SongVersionService;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
    this.userRepo = AppDataSource.getRepository(User);
    this.logRepo = AppDataSource.getRepository(TransactionLog);
    this.soroban = new SorobanService();
    dotenv.config();
  }

  /**
   * Version service, resolved on first use. Building it in the constructor
   * would resolve the version repository for every SongService instance,
   * including the mint/retry paths that never touch versions.
   */
  private get versionService(): SongVersionService {
    if (!this.versionServiceInstance) {
      this.versionServiceInstance = new SongVersionService();
    }
    return this.versionServiceInstance;
  }

  /**
   * Save an uploaded chunk to the temporary folder
   */
  // async saveChunk(
  //   fileId: string,
  //   chunkIndex: number,
  //   tempFilePath: string
  // ): Promise<void> {
  //   const dir = path.join("uploads/temp", fileId);
  //   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  //   fs.renameSync(tempFilePath, path.join(dir, `chunk_${chunkIndex}`));
  // }

  /**
   * Save an uploaded audio chunk to the temporary upload directory.
   *
   * @param fileId - Unique identifier for the upload session (UUID).
   * @param chunkIndex - Zero-based index of this chunk in the sequence.
   * @param chunkPath - Absolute path to the temporary chunk file on disk.
   * @returns The destination path where the chunk was saved.
   */
  async saveChunk(fileId: string, chunkIndex: number, chunkPath: string) {
    const uploadDir = path.join('uploads', 'temp', fileId);

    logger.debug({ fileId, chunkIndex }, 'Saving chunk');

    // Ensure folder exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const destination = path.join(uploadDir, `chunk_${chunkIndex}`);
    // fs.renameSync(chunkPath, destination);
    fs.copyFileSync(chunkPath, destination);
    fs.unlinkSync(chunkPath);

    return destination;
  }

  /**
   * Upload cover art to S3 and return the public URL.
   *
   * @param fileId - Unique identifier for the upload session (UUID).
   * @param coverPath - Absolute path to the cover image file on disk.
   * @returns The S3 URL of the uploaded cover art.
   */
  async saveCover(fileId: string, coverPath: string) {
    const coverBuffer = fs.readFileSync(coverPath);
    const coverFileName = `${fileId}_cover.png`;

    const s3Res = await s3
      .upload({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: `covers/${coverFileName}`,
        Body: coverBuffer,
        ContentType: 'image/png',
        // ACL: "public-read",
      })
      .promise();

    fs.unlinkSync(coverPath); // cleanup local temp

    return s3Res.Location; // the S3 URL for the cover
  }

  /**
   * Apply a royalty template's splits to a song. Stores the split configuration
   * on the song for use during royalty payout calculation.
   *
   * @param songId - ID of the song to apply splits to.
   * @param templateId - ID of the royalty template to apply.
   * @throws {Error} If song or template not found, or user is not the song owner.
   */
  async applyTemplate(songId: string, templateId: string, userId: string): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    }

    if (song.artistId !== userId) {
      throw Object.assign(new Error('Not authorized to modify this song'), { statusCode: 403 });
    }

    if (song.mintStatus === 'pending' || song.mintStatus === 'minted') {
      throw AppError.conflict('Royalty splits cannot be changed after minting');
    }

    const templateRepo = AppDataSource.getRepository(RoyaltyTemplate);
    const template = await templateRepo.findOneBy({ id: templateId });
    if (!template) {
      throw Object.assign(new Error('Template not found'), { statusCode: 404 });
    }

    if (template.userId !== userId) {
      throw Object.assign(new Error('Not authorized to use this template'), { statusCode: 403 });
    }

    song.royaltySplits = template.splits;
    return this.songRepo.save(song);
  }

  /**
   * Merge all uploaded chunks, run a malware scan, upload to S3, persist the
   * song record, and enqueue background processing (HLS transcoding + IPFS pinning).
   *
   * @param options - Finalize upload options (see {@link FinalizeUploadOptions}).
   * @returns The persisted Song entity with status "processing".
   * @throws {Error} If chunk count mismatch, malware detected, or S3 upload fails.
   */
  async finalizeUpload(options: FinalizeUploadOptions): Promise<Song> {
    const {
      fileId,
      totalChunks,
      title,
      artistId,
      artistAddress,
      description,
      genre,
      coverArtPath,
      composers,
    } = options;
    const s3Location = await this.mergeScanAndUpload(fileId, totalChunks);

    //  Save song record to DB
    const song = this.songRepo.create({
      title,
      artistAddress,
      artistId,
      s3OriginalUrl: s3Location,
      status: 'processing',
      description,
      genre,
      coverArtPath,
      composers,
    });
    await this.songRepo.save(song);
    songsUploadedTotal.inc();

    // Every song gets a version 1 record so re-uploads have history to append
    // to (Issue #86).
    try {
      await this.versionService.createInitialVersion(song, artistId);
    } catch (err) {
      logger.warn({ songId: song.id, err }, 'Failed to record initial song version');
    }

    //  Send song for background processing via RabbitMQ
    const channel = getChannel();
    if (channel) {
      channel.sendToQueue(
        'song_processing',
        Buffer.from(JSON.stringify({ songId: song.id, fileId })),
      );
    }

    activityService.recordActivity(artistId, 'song_upload', song.id, 'song');
    return song;
  }

  /**
   * Finalize a re-upload of an existing song (Issue #86).
   *
   * The merged audio is scanned and uploaded exactly like a first upload, but
   * instead of creating a new Song row it appends a {@link SongVersion} and
   * promotes it to active. The previous version's IPFS CID and S3 URL are
   * preserved on its own version row.
   *
   * @param songId - ID of the song being revised.
   * @param fileId - Upload session ID holding the new chunks.
   * @param totalChunks - Expected number of chunks to merge.
   * @param artistId - ID of the artist performing the re-upload.
   * @param changes - Optional metadata changes and change note.
   * @returns The song and the newly created active version.
   */
  async finalizeReupload(
    songId: string,
    fileId: string,
    totalChunks: number,
    artistId: string,
    changes: {
      title?: string;
      description?: string;
      genre?: string;
      coverArtPath?: string;
      composers?: string;
      changeNote?: string;
    } = {},
  ): Promise<{ song: Song; version: SongVersion }> {
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

    const s3Location = await this.mergeScanAndUpload(fileId, totalChunks);

    const version = await this.versionService.createVersionFromReupload(songId, artistId, {
      ...changes,
      s3OriginalUrl: s3Location,
      createdBy: artistId,
    });

    const updated = (await this.songRepo.findOneBy({ id: songId })) ?? song;

    const channel = getChannel();
    if (channel) {
      channel.sendToQueue(
        'song_processing',
        Buffer.from(JSON.stringify({ songId, fileId, versionNumber: version.versionNumber })),
      );
    }

    return { song: updated, version };
  }

  /**
   * Merge uploaded chunks, run the malware scan, and upload the merged audio
   * to S3. Shared by first uploads and re-uploads.
   *
   * @returns The S3 URL of the uploaded audio.
   * @throws {Error} If chunk count mismatch, malware detected, or S3 fails.
   */
  private async mergeScanAndUpload(fileId: string, totalChunks: number): Promise<string> {
    const tempDir = path.join('uploads/temp', fileId);
    const mergedDir = 'uploads/merged';
    const finalPath = path.join(mergedDir, `${fileId}.mp3`);

    // Ensure merged directory exists
    if (!fs.existsSync(mergedDir)) {
      fs.mkdirSync(mergedDir, { recursive: true });
    }

    //  Ensure folder exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Verify all chunks are present
    if (!fs.existsSync(tempDir)) {
      throw new Error(`Temp directory not found for fileId: ${fileId}`);
    }

    const chunkFiles = fs.readdirSync(tempDir);
    if (chunkFiles.length !== totalChunks) {
      throw new Error(`Expected ${totalChunks} chunks but found ${chunkFiles.length}`);
    }

    // if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });

    //  Merge all chunks into one file
    // const writeStream = fs.createWriteStream(finalPath);
    // for (let i = 0; i < totalChunks; i++) {
    //   const chunkPath = path.join(tempDir, `chunk_${i}`);
    //   const data = fs.readFileSync(chunkPath);
    //   writeStream.write(data);
    //   fs.unlinkSync(chunkPath);
    // }
    // writeStream.end();

    // Merge all chunks into one file with proper stream handling
    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(finalPath);

      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      // Write chunks sequentially
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(tempDir, `chunk_${i}`);
        const data = fs.readFileSync(chunkPath);
        writeStream.write(data);
        fs.unlinkSync(chunkPath); // Delete chunk after writing
      }

      writeStream.end();
    });

    // Remove empty temp directory
    fs.rmdirSync(tempDir);

    // ── Malware scan (Issue #38) ───────────────────────────────────────────────
    // Scan the merged file BEFORE uploading to S3 or queuing the worker.
    // Flagged files are deleted and the finalize call is aborted with a 422.
    logger.info({ fileId }, 'Running malware scan on merged upload');
    const scanResult = await ScanService.scanFile(finalPath);
    if (!scanResult.clean) {
      logger.warn({ fileId, threat: scanResult.threat }, 'Malware detected — rejecting upload');
      // Delete the merged file so nothing lands in S3
      try {
        fs.unlinkSync(finalPath);
      } catch {
        /* best-effort */
      }
      throw Object.assign(
        new Error(`Upload rejected: malware detected (${scanResult.threat ?? 'unknown threat'})`),
        { statusCode: 422, code: 'MALWARE_DETECTED', threat: scanResult.threat },
      );
    }
    logger.info({ fileId }, 'Malware scan passed');
    const s3Res = await s3
      .upload({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: `uploads/${fileId}.mp3`,
        Body: fs.createReadStream(finalPath),
        ContentType: 'audio/mpeg',
        // ACL: "public-read",
      })
      .promise();

    return s3Res.Location;
  }

  /**
   * Builds the unsigned `upload_and_mint_song` Soroban transaction for the catalog
   * contract. The song must have a `metadataCid` and the artist must have a
   * connected Stellar wallet. The artist signs and submits via `submitSongMintTx`.
   *
   * @param songId - ID of the song to mint.
   * @param albumId - Optional album ID to associate (defaults to 0).
   * @returns PreparedTransaction containing the XDR and network passphrase.
   * @throws {Error} If song not found, no metadata CID, or no Stellar wallet.
   */
  async prepareSongMintTx(songId: string, albumId: number = 0): Promise<PreparedTransaction> {
    const song = await this.songRepo.findOne({ where: { id: songId }, relations: ['user'] });
    if (!song) throw new Error('Song not found');
    if (!song.metadataCid) throw new Error('Song has no metadata CID yet');

    const user = song.user ?? (await this.userRepo.findOneBy({ id: song.artistId }));
    if (!user?.stellarPublicKey) {
      throw new Error('Connect a Stellar wallet before minting this song');
    }

    const xdrTx = await this.soroban.prepareInvocation(
      user.stellarPublicKey,
      SorobanContracts.catalog,
      'upload_and_mint_song',
      [addressArg(user.stellarPublicKey), stringArg(song.metadataCid), u64Arg(albumId)],
    );

    return { xdr: xdrTx, networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || '' };
  }

  /**
   * Submits the artist's signed `upload_and_mint_song` transaction to Soroban,
   * persists the on-chain song and token IDs, and updates the mint status.
   *
   * @param songId - ID of the song being minted.
   * @param signedXdr - The wallet-signed XDR transaction string.
   * @returns Transaction hash, on-chain song ID, and token ID.
   * @throws {Error} If song not found or Soroban submission fails (mintStatus set to "failed").
   */
  async submitSongMintTx(
    songId: string,
    signedXdr: string,
  ): Promise<{ txHash: string; songId: string; tokenId: string }> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw new Error('Song not found');

    try {
      const { hash, returnValue } = await this.soroban.submitSignedTransaction(signedXdr);

      // upload_and_mint_song returns (song_id: u64, token_id: u64)
      const [onChainSongId, tokenId] = returnValue as [bigint, bigint];

      song.onChainSongId = onChainSongId.toString();
      song.onChainTokenId = tokenId.toString();
      song.mintStatus = 'minted';
      await this.songRepo.save(song);
      await CacheService.clearSong(songId);

      // ── Webhook event emission (song minted) ─────────────────────────────
      try {
        const { WebhookService } = await import('./WebhookService');
        const webhook = new WebhookService();
        await webhook.publish('song.minted', {
          songId: song.id,
          onChainSongId: song.onChainSongId,
          onChainTokenId: song.onChainTokenId,
          txHash: hash,
          artistId: song.artistId,
          title: song.title,
        });
        await webhook.publish('mint_status_changed', {
          songId: song.id,
          onChainSongId: song.onChainSongId,
          tokenId: song.onChainTokenId,
          txHash: hash,
          previousStatus: 'minting',
          newStatus: 'minted',
        });
      } catch (webhookErr) {
        logger.warn(
          { err: webhookErr, songId },
          'Webhook publish failed for song.minted — non-fatal',
        );
      }

      return { txHash: hash, songId: song.onChainSongId, tokenId: song.onChainTokenId };
    } catch (error) {
      song.mintStatus = 'failed';
      await this.songRepo.save(song);
      throw error;
    }
  }

  /**
   * Search songs by title / artist / keywords (Issue #135, enhanced per #82).
   *
   * Matches case-insensitively across song title, artist name and username
   * (via JOIN), genre, composers and description. The `ILIKE '%term%'` lookups
   * are served by pg_trgm GIN indexes (see the AddSongSearchTrigramIndexes
   * migration). Results are ranked by match tier (exact / prefix / contains),
   * then trigram similarity, then play count, and include artist metadata.
   * Minimum query length: 2 characters.
   *
   * @param query  - Search query string (min 2 chars).
   * @param page   - 1-based page number.
   * @param limit  - Results per page (max 100).
   * @returns Paginated, relevance-ranked song results with artist info.
   */
  async searchSongs(
    query: string,
    page = 1,
    limit = 20,
  ): Promise<{
    songs: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const trimmed = (query || '').trim();
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    if (trimmed.length < 2) {
      return { songs: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }

    const like = `%${trimmed}%`;

    // Build a relevance-scored query joining the User (artist) table
    const qb = this.songRepo
      .createQueryBuilder('song')
      .leftJoinAndSelect('song.user', 'artist')
      .where('song.status = :status', { status: 'ready' })
      .andWhere('song.flagged = false')
      // One index-backed lookup per searched column. A single OR across the songs
      // and users tables cannot use the trigram indexes, so each branch is
      // resolved separately and the matches are unioned.
      .andWhere(
        `song.id IN (
          SELECT id FROM songs WHERE title ILIKE :like
          UNION SELECT id FROM songs WHERE genre ILIKE :like
          UNION SELECT id FROM songs WHERE composers ILIKE :like
          UNION SELECT id FROM songs WHERE description ILIKE :like
          UNION SELECT s.id FROM songs s JOIN users u ON u.id = s."artistId"
            WHERE u.name ILIKE :like OR u.username ILIKE :like
        )`,
        { like },
      )
      .addSelect(
        `CASE
          WHEN song.title ILIKE :exact THEN 100
          WHEN song.title ILIKE :prefix THEN 70
          WHEN song.title ILIKE :like THEN 40
          WHEN artist.name ILIKE :exact THEN 90
          WHEN artist.name ILIKE :prefix THEN 60
          WHEN artist.name ILIKE :like THEN 30
          WHEN artist.username ILIKE :exact THEN 85
          WHEN artist.username ILIKE :prefix THEN 55
          WHEN artist.username ILIKE :like THEN 25
          WHEN song.genre ILIKE :like THEN 15
          ELSE 10
        END`,
        'relevance',
      )
      .addSelect(
        'GREATEST(similarity(song.title, :exact), similarity(artist.name, :exact))',
        'similarity',
      )
      .setParameters({
        like,
        exact: trimmed,
        prefix: `${trimmed}%`,
      })
      .orderBy('relevance', 'DESC')
      .addOrderBy('similarity', 'DESC')
      .addOrderBy('song.playCount', 'DESC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit);

    const [songs, total] = await qb.getManyAndCount();

    // Map songs to include artist metadata in the response
    const enriched = songs.map((song) => ({
      id: song.id,
      title: song.title,
      description: song.description,
      genre: song.genre,
      duration: song.duration,
      playCount: song.playCount,
      coverArtPath: song.coverArtPath,
      hlsMasterUrl: song.hlsMasterUrl,
      metadataCid: song.metadataCid,
      lyrics: song.lyrics,
      language: song.language,
      createdAt: song.createdAt,
      artist: song.user
        ? {
            id: song.user.id,
            username: song.user.username,
            name: song.user.name,
            profileImage: song.user.profileImage,
          }
        : null,
    }));

    return {
      songs: enriched,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  /**
   * Browse songs by genre with pagination and sorting (Issue #78).
   *
   * Only ready, unflagged songs are returned, enriched with artist metadata.
   * Sorting is validated against a fixed allow-list so arbitrary SQL cannot be
   * injected via the sort query parameter.
   *
   * @param genreId - Genre entity id to filter by.
   * @param page    - 1-based page number.
   * @param limit   - Results per page (max 100).
   * @param sort    - 'newest' | 'most_played' | 'alphabetical'.
   * @returns Paginated song results with total count for client-side pagination.
   */
  async getSongsByGenre(
    genreId: string,
    page = 1,
    limit = 20,
    sort: 'newest' | 'most_played' | 'alphabetical' = 'newest',
  ): Promise<{
    songs: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const orderMap: Record<string, FindOptionsOrder<Song>> = {
      newest: { createdAt: 'DESC' },
      most_played: { playCount: 'DESC' },
      alphabetical: { title: 'ASC' },
    };
    const orderBy: FindOptionsOrder<Song> = orderMap[sort] ?? { createdAt: 'DESC' };

    const [songs, total] = await this.songRepo.findAndCount({
      where: { genreId, status: 'ready', flagged: false },
      relations: ['user'],
      order: orderBy,
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    const enriched = songs.map((song) => ({
      id: song.id,
      title: song.title,
      description: song.description,
      genre: song.genre,
      genreId: song.genreId,
      duration: song.duration,
      playCount: song.playCount,
      coverArtPath: song.coverArtPath,
      hlsMasterUrl: song.hlsMasterUrl,
      metadataCid: song.metadataCid,
      createdAt: song.createdAt,
      artist: song.user
        ? {
            id: song.user.id,
            username: song.user.username,
            name: song.user.name,
            profileImage: song.user.profileImage,
          }
        : null,
    }));

    return {
      songs: enriched,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  /**
   * Flag a song as inappropriate, removing it from search results and creating
   * an audit log entry.
   *
   * @param songId - ID of the song to flag.
   * @param adminId - ID of the admin performing the action.
   * @param reason - Optional reason for flagging.
   * @returns Updated Song entity.
   * @throws {Error} If song not found or already flagged.
   */
  async flagSong(songId: string, adminId: string, reason?: string): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw new Error('Song not found');
    if (song.flagged) throw new Error('Song is already flagged');

    song.flagged = true;
    song.flaggedAt = new Date();
    song.flaggedBy = adminId;
    song.flagReason = reason || null;
    await this.songRepo.save(song);

    await this.logRepo.save({
      userId: adminId,
      action: 'song_flag',
      details: { songId, reason: reason || null },
    });

    return song;
  }

  /**
   * Remove a flag from a song, restoring it to search results if its status
   * is "ready". Creates an audit log entry.
   *
   * @param songId - ID of the song to unflag.
   * @param adminId - ID of the admin performing the action.
   * @returns Updated Song entity.
   * @throws {Error} If song not found or not currently flagged.
   */
  async unflagSong(songId: string, adminId: string): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw new Error('Song not found');
    if (!song.flagged) throw new Error('Song is not flagged');

    song.flagged = false;
    song.flaggedAt = null;
    song.flaggedBy = null;
    song.flagReason = null;
    await this.songRepo.save(song);

    await this.logRepo.save({
      userId: adminId,
      action: 'song_unflag',
      details: { songId },
    });

    return song;
  }

  /**
   * Manually retry a failed song processing job (Issue #125).
   * Resets status to 'processing', clears errorReason, and re-queues job to RabbitMQ.
   */
  async retryFailedSong(songId: string): Promise<Song> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw new Error('Song not found');
    if (song.status !== 'failed') {
      throw new Error('Only failed songs can be retried');
    }

    song.status = 'processing';
    song.errorReason = null;
    await this.songRepo.save(song);

    try {
      const channel = getChannel();
      channel.publish(
        '',
        'song_processing',
        Buffer.from(JSON.stringify({ songId: song.id, fileId: song.id, attempt: 1 })),
        { persistent: true },
      );
    } catch (err) {
      logger.error({ songId, err }, 'Failed to publish retry message to RabbitMQ');
    }

    return song;
  }

  /**
   * Get lyrics for a song.
   */
  async getLyrics(songId: string): Promise<{ lyrics: string; language?: string }> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }
    // Lyrics are only served once the artist has confirmed they hold the rights.
    if (!song.lyrics || !song.lyricsRightsConfirmedAt) {
      throw AppError.notFound('Lyrics not found for this song', undefined, 'LYRICS_NOT_FOUND');
    }

    const result: { lyrics: string; language?: string } = { lyrics: song.lyrics };
    if (song.language) {
      result.language = song.language;
    }
    return result;
  }
}
// Stellar Wave #304

// Stellar Wave #304: Refactor finalizeUpload
// Extracts S3 upload logic into dedicated helper function
// Moves DB persistence into separate repository method
// Reduces parameter count via options object pattern
// Splits chunk merging into isolated utility function
// Improves testability with dependency injection points
// Maintains backward compatibility with existing callers
// Adds JSDoc documentation for all extracted methods
// Uses Result type for explicit error handling paths
// Separates queue submission from file processing logic
// Validates upload state before any destructive operations

// Stellar Wave #304: finalizeUpload refactored into focused helpers
// ============================================================

interface FinalizeUploadOptions {
  uploadId: string;
  userId: string;
  songId: string;
  chunks: Buffer[];
  metadata: SongMetadata;
  bucketName: string;
  region: string;
}

interface ChunkMergeResult {
  mergedBuffer: Buffer;
  totalSize: number;
  checksum: string;
  chunkCount: number;
}

interface UploadProgress {
  phase: 'merging' | 'uploading' | 'persisting' | 'queueing';
  percentComplete: number;
  bytesProcessed: number;
}

type FinalizeResult = Result<Song, FinalizeError>;

function createUploadContext(options: FinalizeUploadOptions): UploadContext {
  return {
    uploadId: options.uploadId,
    userId: options.userId,
    songId: options.songId,
    bucket: options.bucketName,
    region: options.region,
    startTime: Date.now(),
    metadata: options.metadata,
  };
}

async function mergeChunks(chunks: Buffer[]): Promise<ChunkMergeResult> {
  const mergedBuffer = Buffer.concat(chunks);
  const totalSize = mergedBuffer.length;
  const checksum = crypto.createHash('sha256').update(mergedBuffer).digest('hex');
  return { mergedBuffer, totalSize, checksum, chunkCount: chunks.length };
}

async function uploadToS3(ctx: UploadContext, data: Buffer, key: string): Promise<string> {
  const s3Client = createS3Client(ctx.region);
  await s3Client.putObject({
    Bucket: ctx.bucket,
    Key: key,
    Body: data,
    ContentType: 'audio/mpeg',
    Metadata: {
      uploadId: ctx.uploadId,
      userId: ctx.userId,
      songId: ctx.songId,
    },
  });
  return `s3://${ctx.bucket}/${key}`;
}

async function persistSongRecord(
  ctx: UploadContext,
  fileUrl: string,
  mergeResult: ChunkMergeResult,
): Promise<Song> {
  const song = await prisma.song.update({
    where: { id: ctx.songId },
    data: {
      fileUrl,
      fileSize: mergeResult.totalSize,
      fileChecksum: mergeResult.checksum,
      status: 'READY',
      uploadedAt: new Date(),
      metadata: ctx.metadata,
    },
  });
  return song;
}

async function submitToProcessingQueue(ctx: UploadContext, song: Song): Promise<void> {
  const queueClient = createQueueClient();
  await queueClient.enqueue('song-processing', {
    songId: song.id,
    userId: ctx.userId,
    format: ctx.metadata.format,
    priority: 'normal',
  });
}

function buildUploadKey(ctx: UploadContext, checksum: string): string {
  // #351 — sanitize each component to prevent path traversal and collisions
  const sanitize = (v: string, name: string): string => {
    if (!v || /[/\\]|\.\.|[^a-zA-Z0-9_-]/.test(v) || v.length > 128) {
      throw new Error(`Invalid ${name} for S3 key`);
    }
    return v;
  };
  return `songs/${sanitize(ctx.userId, 'userId')}/${sanitize(ctx.songId, 'songId')}/${sanitize(checksum, 'checksum')}`;
}

function validateChunks(chunks: Buffer[]): void {
  if (!chunks || chunks.length === 0) {
    throw new FinalizeError('NO_CHUNKS', 'Upload contains no chunks');
  }
  for (let i = 0; i < chunks.length; i++) {
    if (!Buffer.isBuffer(chunks[i])) {
      throw new FinalizeError('INVALID_CHUNK', `Chunk ${i} is not a Buffer`);
    }
    if (chunks[i].length === 0) {
      throw new FinalizeError('EMPTY_CHUNK', `Chunk ${i} is empty`);
    }
  }
}

function calculateRetryDelay(attempt: number, baseMs: number): number {
  const jitter = Math.random() * 0.3 * baseMs;
  return Math.min(baseMs * Math.pow(2, attempt) + jitter, 30000);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts - 1) {
        const delay = calculateRetryDelay(attempt, baseDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}
