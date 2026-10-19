import { getChannel, MAIN_QUEUE, DLQ, closeRabbitMQConnection } from '../config/rabbitmq';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import { TransactionLogService } from '../services/TransactionLogService';
import { SongVersionService } from '../services/Song/SongVersionService';
import { PinataService } from '../services/PinataService';
import { SorobanService } from '../services/Soroban/SorobanService';
import logger from '../config/logger';
import { registerWorkerQueue } from '../utils/gracefulShutdown';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { transcodeToHLS } from '../utils/ffmpeg';
import { S3 } from 'aws-sdk';
import { updateRabbitMQQueueDepth } from '../services/MetricsService';

function getSongRepo() {
  return AppDataSource.getRepository(Song);
}
const MAX_ATTEMPTS = 3;
const s3 = new S3({ region: process.env.AWS_REGION });

interface SongPayload {
  songId: string;
  fileId: string;
  attempt?: number;
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
  const song = await getSongRepo().findOne({ where: { id: songId }, relations: ['user'] });
  if (!song) throw new Error('Song not found');

  const localFile = path.join('uploads/merged', `${fileId}.mp3`);
  const hlsDir = `uploads/hls/${fileId}`;

  // 1. Transcode to HLS
  await transcodeToHLS(localFile, hlsDir, songId);

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

export interface WorkerHealthStatus {
  status: 'ok' | 'degraded' | 'error' | 'not_configured';
  connected: boolean;
  isConsuming: boolean;
  consumerTag: string | null;
  lastJobProcessedAt: string | null;
  lastJobStartedAt: string | null;
  jobsProcessedCount: number;
  jobsFailedCount: number;
  pendingJobsCount: number;
  activeConsumersCount: number;
  isStale: boolean;
  staleThresholdMs: number;
  uptimeSeconds: number;
  startedAt: string | null;
  message?: string;
}

// In-memory worker telemetry state
let workerStartedAt: Date | null = null;
let isConsuming = false;
let consumerTag: string | null = null;
let lastJobProcessedAt: Date | null = null;
let lastJobStartedAt: Date | null = null;
let jobsProcessedCount = 0;
let jobsFailedCount = 0;

// eslint-disable-next-line complexity, max-lines-per-function
export async function getWorkerHealthStatus(
  customThresholdMs?: number,
): Promise<WorkerHealthStatus> {
  const staleThresholdMs =
    customThresholdMs ?? parseInt(process.env.WORKER_STALE_THRESHOLD_MS || '300000', 10); // 5 min default

  const uptimeSeconds = workerStartedAt
    ? Math.floor((Date.now() - workerStartedAt.getTime()) / 1000)
    : 0;

  if (!process.env.RABBITMQ_URL) {
    return {
      status: 'not_configured',
      connected: false,
      isConsuming: false,
      consumerTag: null,
      lastJobProcessedAt: null,
      lastJobStartedAt: null,
      jobsProcessedCount: 0,
      jobsFailedCount: 0,
      pendingJobsCount: 0,
      activeConsumersCount: 0,
      isStale: false,
      staleThresholdMs,
      uptimeSeconds: 0,
      startedAt: null,
      message: 'RABBITMQ_URL is not configured',
    };
  }

  let channel: any = null;
  try {
    channel = getChannel();
  } catch {
    channel = null;
  }

  if (!channel) {
    return {
      status: 'error',
      connected: false,
      isConsuming: false,
      consumerTag,
      lastJobProcessedAt: lastJobProcessedAt ? lastJobProcessedAt.toISOString() : null,
      lastJobStartedAt: lastJobStartedAt ? lastJobStartedAt.toISOString() : null,
      jobsProcessedCount,
      jobsFailedCount,
      pendingJobsCount: 0,
      activeConsumersCount: 0,
      isStale: false,
      staleThresholdMs,
      uptimeSeconds,
      startedAt: workerStartedAt ? workerStartedAt.toISOString() : null,
      message: 'RabbitMQ channel is disconnected or unavailable',
    };
  }

  let pendingJobsCount = 0;
  let activeConsumersCount = 0;

  try {
    const queueInfo = await channel.checkQueue(MAIN_QUEUE);
    pendingJobsCount = queueInfo.messageCount;
    activeConsumersCount = queueInfo.consumerCount;
    updateRabbitMQQueueDepth(MAIN_QUEUE, pendingJobsCount);
  } catch (err: any) {
    return {
      status: 'error',
      connected: true,
      isConsuming,
      consumerTag,
      lastJobProcessedAt: lastJobProcessedAt ? lastJobProcessedAt.toISOString() : null,
      lastJobStartedAt: lastJobStartedAt ? lastJobStartedAt.toISOString() : null,
      jobsProcessedCount,
      jobsFailedCount,
      pendingJobsCount: 0,
      activeConsumersCount: 0,
      isStale: false,
      staleThresholdMs,
      uptimeSeconds,
      startedAt: workerStartedAt ? workerStartedAt.toISOString() : null,
      message: `Failed to inspect queue: ${err?.message || 'unknown error'}`,
    };
  }

  // Stale consumer detection logic (Issue #356)
  let isStale = false;
  let status: 'ok' | 'degraded' | 'error' = 'ok';
  let message = 'Worker consumer is healthy and active';

  if (activeConsumersCount === 0) {
    status = 'error';
    isStale = pendingJobsCount > 0;
    message = `No active consumers on queue '${MAIN_QUEUE}' (${pendingJobsCount} jobs pending)`;
  } else if (pendingJobsCount > 0) {
    const baseline = lastJobProcessedAt || lastJobStartedAt || workerStartedAt;
    const timeSinceActivity = baseline ? Date.now() - baseline.getTime() : Infinity;

    if (timeSinceActivity > staleThresholdMs) {
      isStale = true;
      status = 'degraded';
      const minutes = Math.floor(timeSinceActivity / 60000);
      message = `Stale consumer: ${pendingJobsCount} jobs pending and no job processed in ${minutes} minutes`;
    }
  }

  return {
    status,
    connected: true,
    isConsuming: activeConsumersCount > 0,
    consumerTag,
    lastJobProcessedAt: lastJobProcessedAt ? lastJobProcessedAt.toISOString() : null,
    lastJobStartedAt: lastJobStartedAt ? lastJobStartedAt.toISOString() : null,
    jobsProcessedCount,
    jobsFailedCount,
    pendingJobsCount,
    activeConsumersCount,
    isStale,
    staleThresholdMs,
    uptimeSeconds,
    startedAt: workerStartedAt ? workerStartedAt.toISOString() : null,
    message,
  };
}

export function resetWorkerHealthForTests(): void {
  workerStartedAt = null;
  isConsuming = false;
  consumerTag = null;
  lastJobProcessedAt = null;
  lastJobStartedAt = null;
  jobsProcessedCount = 0;
  jobsFailedCount = 0;
}

export function setWorkerHealthStateForTests(state: {
  startedAt?: Date | null;
  isConsuming?: boolean;
  consumerTag?: string | null;
  lastJobProcessedAt?: Date | null;
  lastJobStartedAt?: Date | null;
  jobsProcessedCount?: number;
  jobsFailedCount?: number;
}): void {
  if (state.startedAt !== undefined) workerStartedAt = state.startedAt;
  if (state.isConsuming !== undefined) isConsuming = state.isConsuming;
  if (state.consumerTag !== undefined) consumerTag = state.consumerTag;
  if (state.lastJobProcessedAt !== undefined) lastJobProcessedAt = state.lastJobProcessedAt;
  if (state.lastJobStartedAt !== undefined) lastJobStartedAt = state.lastJobStartedAt;
  if (state.jobsProcessedCount !== undefined) jobsProcessedCount = state.jobsProcessedCount;
  if (state.jobsFailedCount !== undefined) jobsFailedCount = state.jobsFailedCount;
}

export async function startSongWorker() {
  try {
    const channel = getChannel();
    const prefetch = Number(process.env.WORKER_PREFETCH || '1');
    if (!Number.isSafeInteger(prefetch) || prefetch < 1) {
      throw new Error('WORKER_PREFETCH must be a positive integer');
    }
    await channel.prefetch(prefetch);
    const logService = new TransactionLogService();
    const versionService = new SongVersionService();

    await channel.assertQueue(MAIN_QUEUE, { durable: true });
    await channel.assertQueue(DLQ, { durable: true });

    workerStartedAt = new Date();
    logger.info(`🎵 Waiting for messages in queue: ${MAIN_QUEUE} (max attempts: ${MAX_ATTEMPTS})`);

    const registration = registerWorkerQueue(channel, closeRabbitMQConnection);
    const consumeResult = await channel.consume(MAIN_QUEUE, async (msg) => {
      if (!msg) return;

      await registration.handle(msg, async (isActive) => {
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

        lastJobStartedAt = new Date();

        try {
          await processSongMessage(payload, logService, versionService);
          lastJobProcessedAt = new Date();
          jobsProcessedCount++;
          if (isActive()) channel.ack(msg);
        } catch (error) {
          jobsFailedCount++;
          if (isActive()) handleFailure(channel, msg, payload, error);
        }
      });
    });

    if (consumeResult && consumeResult.consumerTag) {
      await registration.setConsumerTag(consumeResult.consumerTag);
      consumerTag = consumeResult.consumerTag;
      isConsuming = true;
    }
    return isConsuming;
  } catch (error) {
    isConsuming = false;
    logger.error({ err: error }, 'Failed to start song worker');
    return false;
  }
}
