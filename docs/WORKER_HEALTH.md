# Song-Processing Worker Health & On-Call Runbook

This document describes the health monitoring, liveness observation, stale consumer detection, and remediation procedures for the AudioBlocks song-processing RabbitMQ worker (Issue #356).

---

## 1. Overview & Architecture

Song processing (FFmpeg audio transcoding to HLS, S3 segment uploads, Pinata IPFS metadata pinning, and on-chain minting preparation) is performed asynchronously by background consumers consuming from the `song_processing` queue on RabbitMQ.

```
[API Server / finalizeUpload]
          │
          ▼ Enqueue message
   [RabbitMQ: song_processing]
          │
          ▼ Consume message
   [SongProcessorWorker]
          │
          ├── Transcode MP3 → HLS (.m3u8, .ts)
          ├── Upload HLS to AWS S3
          ├── Pin Cover & Metadata to Pinata/IPFS
          └── Create Song Version & Database Records
```

If the background worker process crashes, becomes disconnected from RabbitMQ, or hangs on a heavy transcoding process, jobs will queue up without being processed.

---

## 2. Health Check Endpoints

### `GET /health/worker`
Publicly accessible liveness and queue inspection endpoint used by container orchestrators, load balancers, and Prometheus blackbox exporters.

#### Query Parameters
- `staleThresholdMs` (optional, default `300000` / 5 minutes): Milliseconds without processing activity while jobs are pending before marking the consumer as stale.

#### Response Status Codes
- `200 OK`: Worker is connected, consuming, and healthy (or not configured in environments without RabbitMQ).
- `503 Service Unavailable`: Worker channel disconnected, zero active consumers on queue, or stale consumer detected.

#### Response Payload Schema
```json
{
  "status": "ok",
  "connected": true,
  "isConsuming": true,
  "consumerTag": "amq.ctag-xJ9k1...",
  "lastJobProcessedAt": "2026-10-18T09:45:00.000Z",
  "lastJobStartedAt": "2026-10-18T09:44:50.000Z",
  "jobsProcessedCount": 42,
  "jobsFailedCount": 1,
  "pendingJobsCount": 0,
  "activeConsumersCount": 1,
  "isStale": false,
  "staleThresholdMs": 300000,
  "uptimeSeconds": 1420,
  "startedAt": "2026-10-18T09:21:20.000Z",
  "message": "Worker consumer is healthy and active"
}
```

### `GET /health/detailed` (Admin Authenticated)
Includes the full worker status object alongside database pool stats, Redis latency, and memory telemetry.

---

## 3. Stale Consumer Detection Algorithm

A consumer is classified as **stale** (`status: "degraded"`, `isStale: true`) when:
1. `pendingJobsCount > 0` (there is pending work in `song_processing`), **AND**
2. `Date.now() - max(lastJobProcessedAt, lastJobStartedAt, workerStartedAt) > staleThresholdMs`.

If `activeConsumersCount === 0`, the status is immediately flagged as `status: "error"` (`isStale: true` if pending jobs exist).

---

## 4. Prometheus Metrics & Alerting

The following metrics are exported at `/metrics`:

| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `song_worker_consumer_connected` | Gauge | `1` if connected and consuming, `0` if disconnected |
| `song_worker_pending_jobs` | Gauge | Number of unprocessed messages in `song_processing` |
| `song_worker_stale` | Gauge | `1` if consumer is stale, `0` if healthy |
| `song_worker_last_processed_timestamp_seconds` | Gauge | Unix timestamp of the last successfully completed transcode |

### Recommended Prometheus Alert Rule

```yaml
groups:
  - name: audioblock-worker-alerts
    rules:
      - alert: SongWorkerStaleConsumer
        expr: song_worker_stale == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Song processor worker is stale"
          description: "Song processing queue has pending jobs but no activity for > 5 minutes."

      - alert: SongWorkerNoConsumers
        expr: song_worker_consumer_connected == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "No song processor workers connected"
          description: "Zero consumers are currently connected to the RabbitMQ song_processing queue."
```

---

## 5. On-Call Troubleshooting & Remediation Runbook

### Scenario A: `status: "degraded"`, `isStale: true` (Worker Hung / Frozen)
1. **Check Queue Depth**:
   ```bash
   curl -s http://localhost:4000/health/worker | jq .
   ```
2. **Inspect Worker Process Logs**:
   Look for hung `ffmpeg` child processes or external API calls (e.g. S3 timeout or Pinata IPFS gateway lag):
   ```bash
   docker compose logs -f backend
   # or for dedicated worker:
   docker compose logs -f worker
   ```
3. **Restart the Worker Process**:
   ```bash
   # If running via Docker Compose:
   docker compose restart backend
   # Or standalone worker:
   docker compose restart worker
   ```
4. **Verify Recovery**:
   Check that `pendingJobsCount` begins decreasing and `lastJobProcessedAt` advances:
   ```bash
   curl -s http://localhost:4000/health/worker | jq '{status, pendingJobsCount, lastJobProcessedAt}'
   ```

### Scenario B: `status: "error"` (RabbitMQ Disconnected / No Consumers)
1. **Check RabbitMQ Service Status**:
   ```bash
   docker compose ps rabbitmq
   ```
2. **Verify Network Connectivity**:
   ```bash
   docker compose exec backend nc -zv rabbitmq 5672
   ```
3. **Inspect Dead-Letter Queue (`song_processing_dlq`)**:
   If poison messages repeatedly crash workers, check DLQ messages:
   ```bash
   docker compose exec rabbitmq rabbitmqadmin get queue=song_processing_dlq count=5
   ```
