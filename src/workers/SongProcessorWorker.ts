import { getChannel, MAIN_QUEUE, DLQ } from '../config/rabbitmq';
import { AppDataSource } from '../config/data-source';
import { Song } from '../entities/Song';
import { TransactionLogService } from '../services/TransactionLogService';
import { SongVersionService } from '../services/SongVersionService';
import { PinataService } from '../services/PinataService';
import { SorobanService } from '../services/Soroban/SorobanService';
import logger from '../config/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { S3 } from 'aws-sdk';

const songRepo = AppDataSource.getRepository(Song);
const MAX_ATTEMPTS = 3;
const s3 = new S3({ region: process.env.AWS_REGION });

interface SongPayload {
  songId: string;
  fileId: string;
  attempt?: number;
}

/**
 * Transcode an MP3 file to HLS format.
 */
async function transcodeToHLS(localFile: string, hlsDir: string): Promise<void> {
  if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    ffmpeg(localFile)
      .outputOptions([
        '-codec: copy',
        '-start_number 0',
        '-hls_time 10',
        '-hls_list_size 0',
        '-f hls',
      ])
      .output(path.join(hlsDir, 'master.m3u8'))
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/**
 * Upload HLS files to S3.
 */
async function uploadHLSToS3(songId: string, fileId: string): Promise<string> {
  const hlsDir = `uploads/hls/${fileId}`;
  const s3BasePath = `songs/${songId}/hls/`;
  const hlsFiles = fs.readdirSync(hlsDir);

  for (const f of hlsFiles) {
    const filePath = path.join(hlsDir, f);
    await s3
      .upload({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: `${s3BasePath}${f}`,
        Body: fs.createReadStream(filePath),
      })
      .promise();
  }

  return `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com/${s3BasePath}master.m3u8`;
}

/**
 * Build metadata for on-chain minting.
 * Issue #269: Includes AI-generated description if approved by artist.
 */
async function buildMetadata(song: Song, coverCid: string, masterUrl: string) {
  // Use AI-generated description if artist approved it, otherwise use manual description
  const description =
    song.aiGeneratedDescription && song.aiDescriptionApproved
      ? song.aiGeneratedDescription
      : song.description;

  return {
    name: song.title,
    artist: song.artistAddress,
    description,
    image: `ipfs://${coverCid}`,
    animation_url: masterUrl,
    attributes: [
      { trait_type: 'duration', value: song.duration || 0 },
      { trait_type: 'loudness', value: song.loudness || 0 },
      { trait_type: 'genre', value: song.genre },
      { trait_type: 'cover_url', value: coverCid },
      // AI disclosure (#283): flag when any AI-generated content was accepted.
      ...(song.aiGeneratedDescription && song.aiDescriptionApproved
        ? [{ trait_type: 'ai_description_used', value: 'true' }]
        : []),
      ...(song.aiGeneratedCoverUrl && song.aiDescriptionApproved
        ? [{ trait_type: 'ai_cover_used', value: 'true' }]
        : []),
      // Present whenever any AI content was accepted (#283).
      ...(song.aiDescriptionApproved ||
        (song.aiGeneratedCoverUrl && song.aiDescriptionApproved) ||
        (song.aiLyricTranscription && song.aiDescriptionApproved)
        ? [{ trait_type: 'ai_assisted', value: 'true' }]
        : []),
    ],
  };
}

/**
 * Handle a single song processing message.
 */
async function processSongMessage(
  payload: SongPayload,
  logService: TransactionLogService,
  versionService: SongVersionService,
): Promise<void> {
  const { songId, fileId } = payload;
  const song = await songRepo.findOne({ where: { id: songId }, relations: ['user'] });
  if (!song) throw new Error('Song not found');

  const localFile = path.join('uploads/merged', `${fileId}.mp3`);
  const hlsDir = `uploads/hls/${fileId}`;

  // 1. Transcode to HLS
  await transcodeToHLS(localFile, hlsDir);

  // 2. Upload to S3
  const masterUrl = await uploadHLSToS3(songId, fileId);

  // 3. Upload cover art to IPFS
  const tempCoverPath = path.join(os.tmpdir(), `${fileId}-cover.jpg`);
  const coverResponse = await axios.get<ArrayBuffer>(song.coverArtPath, {
    responseType: 'arraybuffer',
  });
  fs.writeFileSync(tempCoverPath, Buffer.from(coverResponse.data));
  const coverRes = await PinataService.uploadFile(tempCoverPath, `${songId}-cover.jpg`);

  // 4. Build and upload metadata
  const metadata = await buildMetadata(song, coverRes.cid, masterUrl);
  const metadataRes = await PinataService.uploadJSON(metadata, `${songId}-metadata.json`);

  // 5. Log and version
  await logService.log(songId, 'hls_transcoded', { masterUrl, metadataCid: metadataRes.cid });
  await versionService.createVersion(songId, metadataRes.cid, masterUrl);

  // 6. Mint on-chain
  const soroban = new SorobanService();
  await soroban.mintSong(song.user!.stellarPublicKey, metadataRes.cid);

  logger.info({ songId, fileId }, 'Song processing complete');
}

/**
 * Parse and validate a queue message.
 */
function parsePayload(raw: string): SongPayload | null {
  try {
    const payload = JSON.parse(raw);
    if (!payload.songId || !payload.fileId) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Handle message failure (retry or DLQ).
 */
function handleFailure(channel: any, msg: any, payload: SongPayload, error: unknown): void {
  const attempt = (payload.attempt ?? 1) + 1;
  logger.error({ songId: payload.songId, attempt, err: error }, 'Song processing failed');

  if (attempt >= MAX_ATTEMPTS) {
    logger.error({ songId: payload.songId }, 'Max attempts reached, sending to DLQ');
    channel.nack(msg, false, false); // Send to DLQ
  } else {
    // Requeue with incremented attempt
    channel.sendToQueue(MAIN_QUEUE, Buffer.from(JSON.stringify({ ...payload, attempt })), {
      persistent: true,
      expiration: String(60_000 * attempt), // Exponential backoff
    });
    channel.ack(msg);
  }
}

export async function startSongWorker() {
  try {
    const channel = getChannel();
    const logService = new TransactionLogService();
    const versionService = new SongVersionService();

    await channel.assertQueue(MAIN_QUEUE, { durable: true });
    await channel.assertQueue(DLQ, { durable: true });

    logger.info(`🎵 Waiting for messages in queue: ${MAIN_QUEUE} (max attempts: ${MAX_ATTEMPTS})`);

    channel.consume(MAIN_QUEUE, async (msg) => {
      if (!msg) return;

      const payload = parsePayload(msg.content.toString());
      if (!payload) {
        logger.error({ raw: msg.content.toString() }, 'Malformed queue message, discarding');
        channel.nack(msg, false, false);
        return;
      }

      const attempt = payload.attempt ?? 1;
      logger.info(
        { songId: payload.songId, attempt },
        `Processing song (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );

      try {
        await processSongMessage(payload, logService, versionService);
        channel.ack(msg);
      } catch (error) {
        handleFailure(channel, msg, payload, error);
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start song worker');
  }
}
