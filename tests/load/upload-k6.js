import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/**
 * k6 Load Test Script: Chunked Upload & Finalization Flow (#371)
 *
 * Simulates concurrent artists uploading audio files in chunks and finalizing:
 * 1. POST /api/song/upload/chunk (multipart/form-data)
 * 2. POST /api/song/upload/finalize (application/json)
 *
 * Measures:
 * - Chunk upload latency & throughput
 * - Finalize endpoint latency (merging, ClamAV scan, S3 upload, DB, RabbitMQ)
 * - Overall upload completion success rate
 *
 * Usage:
 *   k6 run tests/load/upload-k6.js
 *   BASE_URL=http://localhost:3000 ARTIST_TOKEN=<jwt> k6 run tests/load/upload-k6.js
 */

const chunkLatency = new Trend('chunk_upload_duration_ms');
const finalizeLatency = new Trend('finalize_duration_ms');
const uploadSuccessRate = new Rate('upload_flow_success_rate');
const bytesUploadedCounter = new Counter('bytes_uploaded_total');

export const options = {
  stages: [
    { duration: '15s', target: 5 }, // Ramp up to 5 concurrent artists
    { duration: '30s', target: 10 }, // Scale to 10 concurrent artists
    { duration: '30s', target: 20 }, // Peak at 20 concurrent artists
    { duration: '15s', target: 0 }, // Graceful ramp down
  ],
  thresholds: {
    chunk_upload_duration_ms: ['p(95)<800', 'p(99)<1500'],
    finalize_duration_ms: ['p(95)<3000', 'p(99)<5000'],
    upload_flow_success_rate: ['rate>0.95'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const ARTIST_TOKEN = __ENV.ARTIST_TOKEN || '';

// Minimal MP3 header (valid frame header to satisfy audio mime sniffers)
const DUMMY_AUDIO_CHUNK = new Uint8Array([
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x54, 0x41, 0x47, 0x00,
]);

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function () {
  const fileId = generateUuid();
  const totalChunks = 2;
  let allChunksSucceeded = true;

  const authHeaders = ARTIST_TOKEN ? { Authorization: `Bearer ${ARTIST_TOKEN}` } : {};

  // Step 1: Upload Chunks sequentially for this fileId
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const chunkFile = http.file(
      DUMMY_AUDIO_CHUNK.buffer,
      `chunk_${chunkIndex}.mp3`,
      'audio/mpeg',
    );

    const formData = {
      fileId: fileId,
      chunkIndex: String(chunkIndex),
      chunk: chunkFile,
    };

    const chunkStartTime = Date.now();
    const chunkRes = http.post(`${BASE_URL}/api/song/upload/chunk`, formData, {
      headers: authHeaders,
      tags: { name: 'UploadChunk' },
    });
    const chunkDuration = Date.now() - chunkStartTime;
    chunkLatency.add(chunkDuration);
    bytesUploadedCounter.add(DUMMY_AUDIO_CHUNK.length);

    const chunkOk = check(chunkRes, {
      'chunk status is 200': (r) => r.status === 200,
    });

    if (!chunkOk) {
      allChunksSucceeded = false;
      break;
    }
  }

  // Step 2: Finalize the upload once all chunks are transferred
  if (allChunksSucceeded) {
    const finalizePayload = JSON.stringify({
      fileId: fileId,
      totalChunks: totalChunks,
      title: `Load Test Track ${fileId.substring(0, 8)}`,
      description: 'Automated concurrent load test track',
      genre: 'Afrobeats',
      coverArtPath: 'covers/default_cover.png',
      composers: 'Load Test Artist',
    });

    const finalizeStartTime = Date.now();
    const finalizeRes = http.post(`${BASE_URL}/api/song/upload/finalize`, finalizePayload, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `finalize-${fileId}`,
        ...authHeaders,
      },
      tags: { name: 'FinalizeUpload' },
    });
    const finalizeDuration = Date.now() - finalizeStartTime;
    finalizeLatency.add(finalizeDuration);

    const finalizeOk = check(finalizeRes, {
      'finalize status is 201': (r) => r.status === 201,
      'finalize returns song data': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.success === true && !!body.data;
        } catch {
          return false;
        }
      },
    });

    uploadSuccessRate.add(finalizeOk);
  } else {
    uploadSuccessRate.add(false);
  }

  sleep(0.5 + Math.random() * 0.5);
}
