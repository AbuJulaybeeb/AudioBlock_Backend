import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

export class TranscodeError extends Error {
  readonly stderrTail: string;
  constructor(message: string, stderr: string = '') {
    super(message);
    this.name = 'TranscodeError';
    this.stderrTail = stderr.slice(-4096);
  }
}

export async function transcodeToHLS(
  inputPath: string,
  outputDir: string,
  songId?: string,
): Promise<void> {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-codec: copy',
          '-start_number 0',
          '-hls_time 10',
          '-hls_list_size 0',
          '-f hls',
        ])
        .output(path.join(outputDir, 'master.m3u8'))
        .on('end', () => resolve())
        .on('error', (err, _stdout, stderr) =>
          reject(new TranscodeError(err.message, stderr ?? '')),
        )
        .run();
    });
    logger.info({ songId, outputDir }, 'HLS transcoding complete');
  } catch (err) {
    const error =
      err instanceof TranscodeError
        ? err
        : new TranscodeError(err instanceof Error ? err.message : String(err));
    logger.error(
      { songId, outputDir, err: error, stderrTail: error.stderrTail },
      'HLS transcoding failed',
    );
    throw error;
  }

const HLS_AUDIO_BITRATE = process.env.HLS_AUDIO_BITRATE || '256k';

/**
 * Re-encodes any supported audio file to AAC-LC HLS:
 * - Drops embedded cover art / video streams (-vn)
 * - Encodes to AAC at HLS_AUDIO_BITRATE (default 256k), 44.1 kHz
 * - Writes 10s fMP4 segments (init.mp4 + .m4s), which play gaplessly and are
 *   supported by Safari/iOS native HLS and hls.js
 * - Generates master.m3u8 playlist
 */
export async function transcodeToHLS(inputPath: string, outputDir: string): Promise<void> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vn',
        '-c:a aac',
        `-b:a ${HLS_AUDIO_BITRATE}`,
        '-ar 44100',
        '-start_number 0',
        '-hls_time 10', // 10s per segment
        '-hls_list_size 0', // include all segments
        '-hls_segment_type fmp4',
        '-f hls', // output format
      ])
      .output(path.join(outputDir, 'master.m3u8'))
      .on('end', () => {
        logger.info({ outputDir }, 'HLS transcoding complete');
        resolve();
      })
      .on('error', (err) => {
        logger.error({ err }, 'FFmpeg HLS transcoding failed');
        reject(err);
      })
      .run();
  });
}
