/**
 * Production Load Test Script: Chunked Audio Upload & Finalization (#371)
 *
 * Implements Issue #371:
 * Benchmarks POST /api/song/upload/chunk and POST /api/song/upload/finalize
 * under concurrent artist uploads.
 * Measures chunk transport latency, finalization latency (disk merge, ClamAV
 * scan, S3 upload, DB persist, RabbitMQ dispatch), and throughput.
 *
 * Usage:
 *   npx ts-node scripts/load-test-chunked-upload.ts
 *   or:
 *   npm run test:load:upload
 *
 * Environment Variables:
 *   UPLOAD_BENCH_BASE_URL          Base API URL (default: http://localhost:3000)
 *   UPLOAD_BENCH_CONCURRENCY       Comma-separated artist levels (default: 1,5,10,20)
 *   UPLOAD_BENCH_UPLOADS_PER_LEVEL Number of full song uploads per tier (default: 20)
 *   UPLOAD_BENCH_CHUNK_SIZE_KB     Size of each chunk in KB (default: 64)
 *   UPLOAD_BENCH_CHUNKS_PER_SONG   Number of chunks per song (default: 2)
 *   UPLOAD_BENCH_JWT_SECRET        Secret used to sign test JWT (default: test-secret)
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import FormData from 'form-data';
import { performance } from 'perf_hooks';

interface BenchmarkConfig {
  baseUrl: string;
  concurrencyLevels: number[];
  uploadsPerLevel: number;
  chunkSizeKb: number;
  chunksPerSong: number;
  jwtSecret: string;
}

interface UploadTierMetrics {
  concurrency: number;
  totalUploads: number;
  successfulUploads: number;
  failedUploads: number;
  chunkDurationStats: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
  };
  finalizeDurationStats: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
  };
  totalMegabytesUploaded: number;
  throughputMbPerSec: number;
  finalizationsPerSec: number;
}

const config: BenchmarkConfig = {
  baseUrl: process.env.UPLOAD_BENCH_BASE_URL || 'http://localhost:3000',
  concurrencyLevels: (process.env.UPLOAD_BENCH_CONCURRENCY || '1,5,10,20')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0),
  uploadsPerLevel: parseInt(process.env.UPLOAD_BENCH_UPLOADS_PER_LEVEL || '20', 10),
  chunkSizeKb: parseInt(process.env.UPLOAD_BENCH_CHUNK_SIZE_KB || '64', 10),
  chunksPerSong: parseInt(process.env.UPLOAD_BENCH_CHUNKS_PER_SONG || '2', 10),
  jwtSecret: process.env.JWT_SECRET || process.env.UPLOAD_BENCH_JWT_SECRET || 'test-secret',
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// Pre-create dummy audio buffer with valid ID3v2 header
function createDummyAudioBuffer(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(sizeBytes, 32), 0);
  // Valid ID3 header marker
  buf.write('ID3', 0, 3, 'ascii');
  buf[3] = 0x03; // version 2.3
  buf[4] = 0x00; // flags
  return buf;
}

const SHARED_CHUNK_BUFFER = createDummyAudioBuffer(config.chunkSizeKb * 1024);

function generateArtistToken(artistId: string): string {
  return jwt.sign(
    {
      id: artistId,
      role: 'artist',
      walletAddress: 'GANAN2HWN3JA4VUB4G7ELF4442LJJKLKTYEGEJ4ZDPIEHSOSRTCKQHDY',
    },
    config.jwtSecret,
    { expiresIn: '2h' },
  );
}

function calculatePercentiles(durations: number[]) {
  if (durations.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const p = (pct: number) => sorted[Math.min(Math.floor((pct / 100) * n), n - 1)];
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    p50: parseFloat(p(50).toFixed(2)),
    p90: parseFloat(p(90).toFixed(2)),
    p95: parseFloat(p(95).toFixed(2)),
    p99: parseFloat(p(99).toFixed(2)),
    min: parseFloat(sorted[0].toFixed(2)),
    max: parseFloat(sorted[n - 1].toFixed(2)),
    avg: parseFloat((sum / n).toFixed(2)),
  };
}

/**
 * Upload an individual audio chunk via POST /api/song/upload/chunk
 */
function uploadChunk(
  fileId: string,
  chunkIndex: number,
  token: string,
): Promise<{ statusCode: number; durationMs: number }> {
  const parsed = new URL(`${config.baseUrl}/api/song/upload/chunk`);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  const form = new FormData();
  form.append('fileId', fileId);
  form.append('chunkIndex', String(chunkIndex));
  form.append('chunk', SHARED_CHUNK_BUFFER, {
    filename: `chunk_${chunkIndex}.mp3`,
    contentType: 'audio/mpeg',
  });

  return new Promise((resolve, reject) => {
    const start = performance.now();

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        agent,
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume(); // drain response
        res.on('end', () => {
          const durationMs = performance.now() - start;
          resolve({ statusCode: res.statusCode || 0, durationMs });
        });
      },
    );

    req.on('error', reject);
    form.pipe(req);
  });
}

/**
 * Finalize uploaded chunks via POST /api/song/upload/finalize
 */
function finalizeUpload(
  fileId: string,
  totalChunks: number,
  token: string,
): Promise<{ statusCode: number; durationMs: number }> {
  const parsed = new URL(`${config.baseUrl}/api/song/upload/finalize`);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  const body = JSON.stringify({
    fileId,
    totalChunks,
    title: `Load Test Track ${fileId.substring(0, 8)}`,
    description: 'Automated concurrent load test track',
    genre: 'Afrobeats',
    coverArtPath: 'covers/default_cover.png',
    composers: 'Load Test Artist',
  });

  return new Promise((resolve, reject) => {
    const start = performance.now();

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': `finalize-${fileId}`,
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const durationMs = performance.now() - start;
          resolve({ statusCode: res.statusCode || 0, durationMs });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Execute an end-to-end artist upload pipeline:
 * Serial chunk uploads for the fileId -> Finalize call.
 */
async function executeArtistUpload(
  token: string,
): Promise<{ success: boolean; chunkDurations: number[]; finalizeDuration: number }> {
  const fileId = crypto.randomUUID();
  const chunkDurations: number[] = [];

  // 1. Upload chunks in sequence
  for (let i = 0; i < config.chunksPerSong; i++) {
    const chunkRes = await uploadChunk(fileId, i, token);
    chunkDurations.push(chunkRes.durationMs);
    if (chunkRes.statusCode !== 200) {
      return { success: false, chunkDurations, finalizeDuration: 0 };
    }
  }

  // 2. Finalize merged audio
  const finRes = await finalizeUpload(fileId, config.chunksPerSong, token);
  const success = finRes.statusCode === 201;

  return {
    success,
    chunkDurations,
    finalizeDuration: finRes.durationMs,
  };
}

async function runUploadConcurrencyTier(
  concurrency: number,
  totalUploads: number,
): Promise<UploadTierMetrics> {
  const token = generateArtistToken('load-test-artist-id');
  const allChunkDurations: number[] = [];
  const allFinalizeDurations: number[] = [];
  let successfulUploads = 0;
  let failedUploads = 0;

  let cursor = 0;
  const tierStart = performance.now();

  const worker = async () => {
    while (cursor < totalUploads) {
      cursor++;
      try {
        const result = await executeArtistUpload(token);
        allChunkDurations.push(...result.chunkDurations);

        if (result.success) {
          successfulUploads++;
          allFinalizeDurations.push(result.finalizeDuration);
        } else {
          failedUploads++;
        }
      } catch {
        failedUploads++;
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, totalUploads) }, () => worker());
  await Promise.all(pool);

  const tierSeconds = (performance.now() - tierStart) / 1000;
  const totalMB = (successfulUploads * config.chunksPerSong * config.chunkSizeKb) / 1024;

  const chunkStats = calculatePercentiles(allChunkDurations);
  const finalizeStats = calculatePercentiles(allFinalizeDurations);

  return {
    concurrency,
    totalUploads,
    successfulUploads,
    failedUploads,
    chunkDurationStats: {
      p50: chunkStats.p50,
      p95: chunkStats.p95,
      p99: chunkStats.p99,
      avg: chunkStats.avg,
    },
    finalizeDurationStats: {
      p50: finalizeStats.p50,
      p95: finalizeStats.p95,
      p99: finalizeStats.p99,
      avg: finalizeStats.avg,
    },
    totalMegabytesUploaded: parseFloat(totalMB.toFixed(2)),
    throughputMbPerSec: parseFloat((totalMB / (tierSeconds || 1)).toFixed(2)),
    finalizationsPerSec: parseFloat((successfulUploads / (tierSeconds || 1)).toFixed(2)),
  };
}

export async function runChunkedUploadBenchmark(): Promise<void> {
  console.log('='.repeat(75));
  console.log('   AudioBlock Chunked Upload & Finalize Load Benchmark (#371)');
  console.log('='.repeat(75));
  console.log(`Base URL:         ${config.baseUrl}`);
  console.log(`Concurrency:      ${config.concurrencyLevels.join(', ')} artists`);
  console.log(`Uploads / Level:  ${config.uploadsPerLevel}`);
  console.log(
    `Chunk Payload:    ${config.chunksPerSong} x ${config.chunkSizeKb} KB (${(config.chunksPerSong * config.chunkSizeKb) / 1024} MB per song)`,
  );
  console.log('-'.repeat(75));

  const results: UploadTierMetrics[] = [];

  for (const level of config.concurrencyLevels) {
    process.stdout.write(
      `  Testing ${level} concurrent artists (${config.uploadsPerLevel} full uploads)... `,
    );
    const metrics = await runUploadConcurrencyTier(level, config.uploadsPerLevel);
    results.push(metrics);
    console.log(
      `Done! Chunk p95=${metrics.chunkDurationStats.p95}ms | Finalize p95=${metrics.finalizeDurationStats.p95}ms | ${metrics.throughputMbPerSec} MB/s`,
    );
  }

  // Summary Table
  console.log('\n' + '='.repeat(75));
  console.log('  CHUNKED UPLOAD & FINALIZATION BENCHMARK SUMMARY');
  console.log('='.repeat(75));
  console.log(
    'Artists'.padEnd(9) +
      'Uploads'.padEnd(9) +
      'Chunk p50'.padEnd(11) +
      'Chunk p95'.padEnd(11) +
      'Fin p50'.padEnd(10) +
      'Fin p95'.padEnd(10) +
      'Throughput'.padEnd(12) +
      'Success%',
  );
  console.log('-'.repeat(75));

  for (const r of results) {
    const successRate =
      r.totalUploads > 0 ? ((r.successfulUploads / r.totalUploads) * 100).toFixed(0) : '0';
    console.log(
      String(r.concurrency).padEnd(9) +
        String(r.totalUploads).padEnd(9) +
        `${r.chunkDurationStats.p50}ms`.padEnd(11) +
        `${r.chunkDurationStats.p95}ms`.padEnd(11) +
        `${r.finalizeDurationStats.p50}ms`.padEnd(10) +
        `${r.finalizeDurationStats.p95}ms`.padEnd(10) +
        `${r.throughputMbPerSec} MB/s`.padEnd(12) +
        `${successRate}%`,
    );
  }
  console.log('='.repeat(75));
}

// Direct CLI invocation
if (require.main === module) {
  runChunkedUploadBenchmark()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal load test error:', err);
      process.exit(1);
    });
}
