import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/**
 * k6 Load Test Script: Song Streaming Endpoint (#370)
 *
 * Simulates high concurrent streaming traffic on GET /api/song/stream/:id.
 * Verifies Redis manifest caching latency, throughput, and error rates under load.
 *
 * Usage:
 *   k6 run tests/load/stream-k6.js
 *   BASE_URL=http://localhost:3000 SONG_ID=<song-uuid> k6 run tests/load/stream-k6.js
 */

const streamLatency = new Trend('stream_request_duration_ms');
const streamSuccessRate = new Rate('stream_success_rate');
const cacheHitRate = new Rate('stream_cache_hit_rate');
const streamErrorCounter = new Counter('stream_errors_total');

export const options = {
  stages: [
    { duration: '15s', target: 10 }, // Ramp-up to 10 VUs
    { duration: '30s', target: 50 }, // Ramp-up to 50 VUs
    { duration: '30s', target: 100 }, // Peak load at 100 VUs
    { duration: '15s', target: 0 }, // Graceful ramp-down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<250', 'p(99)<500'], // 95% under 250ms, 99% under 500ms
    stream_request_duration_ms: ['p(95)<200'],
    stream_success_rate: ['rate>0.99'], // >99% success rate
    http_req_failed: ['rate<0.01'], // <1% failure rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SONG_ID = __ENV.SONG_ID || '00000000-0000-0000-0000-000000000001';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const url = `${BASE_URL}/api/song/stream/${SONG_ID}`;

  const params = {
    headers: {
      Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    tags: { name: 'GetStreamManifest' },
  };

  const startTime = Date.now();
  const res = http.get(url, params);
  const duration = Date.now() - startTime;

  streamLatency.add(duration);

  const isSuccess = check(res, {
    'status is 200': (r) => r.status === 200,
    'content-type is mpegurl': (r) => {
      const ct = r.headers['Content-Type'] || r.headers['content-type'] || '';
      return ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl');
    },
    'body contains HLS tags': (r) => typeof r.body === 'string' && r.body.includes('#EXT'),
  });

  streamSuccessRate.add(isSuccess);

  if (isSuccess) {
    // Fast response under 50ms implies Redis hot cache hit
    const isCacheHit = duration < 50;
    cacheHitRate.add(isCacheHit);
  } else {
    streamErrorCounter.add(1);
  }

  // Micro-sleep to emulate audio player buffering pacing
  sleep(0.05 + Math.random() * 0.1);
}
