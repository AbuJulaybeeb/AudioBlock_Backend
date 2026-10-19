# Horizontal scaling of song workers

Scope: `SongProcessorWorker`, consuming RabbitMQ `song_processing`. The Redis
`JobQueueWorker` and on-chain indexer are different processes and need separate
capacity planning. The API also starts a song consumer; include API replicas in
the total consumer count.

## Start and prerequisites

Install dependencies with `npm ci`. Set `NODE_ENV=production`, `POSTGRES_*`,
`RABBITMQ_URL`, `AWS_*`, Pinata and Soroban settings from the
[environment reference](environment-variables.md). Build once with
`npm run build`; use the same artifact/config on all workers.

```bash
# Development checkout (requires ts-node/dev dependencies)
npm run worker
# Built production image (no ts-node dependency; no HTTP listener)
node dist/workers/songWorkerMain.js
```

The standalone entry point loads dotenv, initializes PostgreSQL, connects to
RabbitMQ and starts the song consumer. It exits nonzero if startup fails. It does
not start the Redis job worker or seed the database. Provision schema/migrations
before starting consumers. Use a process/container supervisor to restart failures.
After a broker disconnect, restart workers: the reconnect helper does not
re-register the consumer on its replacement channel.

Every worker **and uploader** must see the same writable `uploads` tree at the
same relative path. Processing reads `uploads/merged/<fileId>.mp3`; it does not
download `s3OriginalUrl`. Mount shared durable storage across hosts and restore
ownership for the container's non-root user. Each worker needs FFmpeg on PATH,
temporary disk for HLS and covers, and access to DB/S3/Pinata/Soroban. S3 storage
alone does not make replicas independent of local files.

Run two instances in separate terminals/containers with identical backing
services and upload mounts:

```bash
WORKER_PREFETCH=1 node dist/workers/songWorkerMain.js
```

In PowerShell set `$env:WORKER_PREFETCH='1'` before the Node command. There is no
song-worker Compose service to scale in this repository. Do not use
`docker compose --scale backend` as a worker deployment: it also starts HTTP,
seeders and Redis consumers, and the base service has a fixed container name.
In the production Docker image override its command to the built worker entry
point and replace the API HTTP healthcheck with a worker-specific check through
your supervisor/broker consumer monitoring.

## Prefetch and concurrency

`WORKER_PREFETCH` defaults to `1` and must be a positive safe integer. The worker
applies `channel.prefetch` before registering its consumer. There is no separate
concurrency pool: the async callback processes deliveries concurrently, so
prefetch bounds both unacknowledged deliveries and in-flight jobs per consumer.
Never use zero (unlimited) for this workload.

| Prefetch | Use | Tradeoff |
| --- | --- | --- |
| 1 | Starting value for CPU/disk intensive jobs and fair sharing | One active delivery per consumer |
| 2 | Trial when measured external I/O waits dominate | Up to twice the active FFmpeg jobs, memory, DB/provider requests |
| Higher | Only after measured representative load tests | More resource pressure and jobs redelivered on process loss; may reduce fairness |

RabbitMQ distributes deliveries among competing consumers on the same queue;
it does not guarantee strict ordering or exactly-once processing. Approximate
maximum active deliveries is the sum of each consumer's prefetch (including API
consumers). Increase replicas first with prefetch 1, then tune one variable at
a time. Start a dedicated worker with approximately 1 vCPU/1 GiB as a provisional
budget, measure realistic file sizes and adjust. FFmpeg currently uses codec copy;
do not assume a fixed CPU cost or guaranteed jobs/sec from the resource budget.

## Instance count and capacity

Measure sustained arrival rate `lambda` (jobs/sec) and mean processing duration
`T` (seconds) over representative uploads. At prefetch 1, a starting estimate is
`ceil(lambda * T / 0.7)` total consumers for roughly 70% utilization. For example,
0.1 jobs/sec and 20 sec/job suggests 3 consumers. Subtract already running API
consumers when deciding how many dedicated workers to add. Validate the estimate
under load: provider rate limits, shared disk and DB can dominate throughput.

For a backlog of `B` jobs to drain within `D` seconds, estimate
`ceil((lambda + B / D) * T / 0.7)` consumers, then cap by measured infrastructure
and provider budgets. More prefetch does not guarantee proportional throughput.
Account for each process's DB pool and each active job's memory, disk and outbound
requests. Observe ready/unacknowledged counts, oldest job age, successful jobs/sec,
job duration, failures, CPU/memory, disk space and DB/provider errors. Add a worker
when sustained job age exceeds the service target and downstream capacity allows
it; stop adding when throughput flattens or failures/latency grow. Scale down only
after uploads are paused and in-flight work has finished.

## Queue depth monitoring and alerting (Issue #377)

Queue depth for `song_processing` is exposed as a Prometheus gauge `rabbitmq_queue_depth{queue="song_processing"}` through `MetricsService` and scraped via `GET /metrics`.

Backlog alerts configured in `monitoring/prometheus-alerts.yml`:
- **`SongProcessingQueueBacklog`** (`rabbitmq_queue_depth{queue="song_processing"} > 10` for 5m, `warning`): Sustained backlog signals stalled consumers, crashed worker processes, or FFmpeg unavailability.
- **`CriticalSongProcessingQueueBacklog`** (`rabbitmq_queue_depth{queue="song_processing"} > 50` for 10m, `critical`): Critical backlog escalation requiring urgent operator intervention (worker restart or horizontal scaling).

When an alert fires:
1. Verify worker container status and logs for unhandled errors or FFmpeg crash loops.
2. Check broker consumer counts: ensure active consumers > 0 on `song_processing`.
3. If consumers are healthy but arrival rate exceeds single-worker processing capacity, scale out worker replicas following the capacity guidelines above.

## Safety limits before production scaling

- Messages are acknowledged after processing, including an on-chain mint. A
  crash between an external effect and acknowledgement may repeat that effect.
  There is no per-song distributed lock or complete idempotency guard here.
  Concurrent duplicate jobs can also collide in HLS/temp paths. Reconcile
  DB/chain state and deduplicate upload requests before replay; unrestricted
  crash/retry safety requires additional implementation.
- Queues are durable, but initial upload publishers do not consistently request
  persistent messages and do not use publisher confirms. Do not infer guaranteed
  delivery from durability. See the [recovery runbook](runbooks/disaster-recovery.md).
- Failure handling uses a hardcoded attempt limit of 3, republishes without
  confirms and uses expiration, which is a TTL, not delayed scheduling. The
  `WORKER_MAX_ATTEMPTS`/backoff example settings do not tune this song consumer.
- Declaring `song_processing_dlq` does not route rejected messages there. A
  broker dead-letter policy/exchange/binding must be verified separately.
- Terminating a busy worker can requeue an unacknowledged job. This entry point
  has no application drain handler; arrange a quiet queue and verify zero
  unacknowledged deliveries before stopping replicas for planned maintenance.
- Existing processing code calls `TransactionLogService.log` and
  `SongVersionService.createVersion`, which are absent from those services.
  Those pipeline/service integration mismatches need a separate fix and an
  end-to-end check before treating these deployment instructions as verified.

## Local multi-process verification

Use a disposable RabbitMQ instance with management access and local credentials,
never a production broker. For example, on a machine with Docker:

```bash
docker run --rm --name audioblock-worker-smoke -p 5672:5672 rabbitmq:3-management
# In another terminal, after the broker is ready:
RABBITMQ_TEST_URL=amqp://guest:guest@localhost:5672 node scripts/test-worker-multi-instance.js
```

The script creates a temporary expiring test queue, launches two child Node processes
with independent connections and prefetch 1, publishes 12 synthetic jobs, and
fails unless both consumers receive work, each processes at most one job at a
time, and every ID is acknowledged once in this no-failure run. It never writes
to the application's queues or calls S3/Pinata/Soroban. Connections and child
processes are closed on completion/failure; a 30-second deadline prevents hangs.
This verifies broker distribution and bounded concurrency, not application
idempotency or an end-to-end upload pipeline.

For the application check, start two actual workers against an isolated staging
DB, test signing accounts and shared uploads; publish distinct known upload
payloads through the normal upload API. Confirm both consumers in RabbitMQ,
matching file access, completed versions/HLS and one expected test mint per
song. Repeat with prefetch 2 while measuring resource pressure. Do not simulate
consumer crashes with real signing accounts until replay protection exists.

Verification record (2026-10-18): live broker and end-to-end multi-instance runs
are pending; this workspace has no Docker executable or supplied test broker.
Seven isolated checks of the actual consumer startup function passed for default,
valid and invalid prefetch values and prefetch-before-consume ordering. The full
compiler check is blocked by existing syntax errors in unrelated test files
included in `tsconfig.json`; a production build has not been certified.
The focused Jest run could not start because the dependency installation was
incomplete (`@babel/types` missing); the default clean install also fails on the
lockfile mismatch recorded in the parity audit. No Jest pass is claimed.
Attach command output, commit, prefetch, consumer counts, throughput and peak
resources here after running them. Issue #375's local multi-instance acceptance
criterion remains open until that evidence exists.
