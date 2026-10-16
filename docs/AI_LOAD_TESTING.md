# AI Abstraction Concurrency Benchmark

Issue #299: how does the AI abstraction layer behave when many artists trigger
AI features at the same time?

## Running it

```bash
npm run benchmark:ai

# Custom provider latency, levels, or a single scenario
AI_BENCH_LATENCY_MS=500 AI_BENCH_CONCURRENCY=10,100 npm run benchmark:ai
AI_BENCH_SCENARIOS=async-jobs npm run benchmark:ai
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `AI_BENCH_CONCURRENCY` | `1,10,50,100,250` | Concurrent-artist levels to run |
| `AI_BENCH_LATENCY_MS` | `200` | Simulated provider latency per call |
| `AI_BENCH_PROVIDER_CAP` | `10` | Provider-side concurrency limit (scenario 3) |
| `AI_BENCH_OVERHEAD_CALLS` | `2000` | Calls per level in the overhead scenario |
| `AI_BENCH_SCENARIOS` | all | Subset of `overhead,sync,sync-capped,async-jobs` |

The script ([`scripts/load-test-ai-concurrency.ts`](../scripts/load-test-ai-concurrency.ts))
runs fully offline. It uses the shared fake provider from
[`tests/helpers/fakeAi.ts`](../tests/helpers/fakeAi.ts) (see
[testing-strategy.md](./testing-strategy.md)), so it needs no API key, makes no
network calls, and gives repeatable numbers. It needs no Postgres, Redis or
RabbitMQ either.

## Scenarios

1. **Abstraction overhead**: a zero-latency provider, called through the real
   `TagSuggestionService → AIProviderService → adapter` path. Measures what
   the abstraction itself costs.
2. **Synchronous features, uncapped provider**: every artist requests tag
   suggestions at the same moment; the provider answers in 200 ms with no
   limit. This is how tag suggestions, playlist curation, tweet drafts,
   moderation triage and search embeddings call the provider today: inside
   the request.
3. **Synchronous features, provider limited to 10 concurrent calls**: same,
   but the provider only serves 10 calls at once, as real vendors do with
   concurrency or rate limits. Extra calls wait in a FIFO queue.
4. **Async jobs through `JobQueueWorker`**: cover art, descriptions and lyric
   transcription are queued through `JobQueueService`. `startJobQueueWorker`
   (`src/workers/JobQueueWorker.ts`) reserves and runs **one job at a time**
   per process. The scenario reproduces that loop and measures latency from
   enqueue to completion, which is what the artist actually waits.

## Results

Node v22.21.0, Linux, 200 ms simulated provider latency, run on 2026-10-16.

### 1. Abstraction overhead (zero-latency provider, ~2000 calls per level)

| Concurrent artists | Calls | p50 ms | p95 ms | p99 ms | max ms | calls/s |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2000 | 0.01 | 0.01 | 0.02 | 2.54 | 86003 |
| 10 | 2000 | 0.06 | 0.11 | 0.18 | 2.18 | 118220 |
| 50 | 2000 | 0.44 | 0.62 | 3.03 | 3.04 | 95547 |
| 100 | 2000 | 0.49 | 0.90 | 2.12 | 2.15 | 156804 |
| 250 | 2000 | 1.31 | 3.84 | 3.85 | 3.86 | 139807 |

### 2. Synchronous AI features, uncapped provider (200 ms/call)

| Concurrent artists | p50 ms | p99 ms | calls/s | Max in-flight at provider |
| --- | --- | --- | --- | --- |
| 1 | 200.96 | 200.96 | 5 | 1 |
| 10 | 200.10 | 200.30 | 50 | 10 |
| 50 | 200.76 | 200.88 | 249 | 50 |
| 100 | 200.04 | 200.32 | 498 | 100 |
| 250 | 200.29 | 200.94 | 1236 | 250 |

### 3. Synchronous AI features, provider limited to 10 concurrent calls

| Concurrent artists | p50 ms | p95 ms | p99 ms | calls/s | Max in-flight | Max queue wait ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 200.89 | 200.89 | 200.89 | 5 | 1 | 0 |
| 10 | 200.38 | 200.45 | 200.45 | 50 | 10 | 0 |
| 50 | 601.62 | 1002.51 | 1002.54 | 50 | 10 | 802 |
| 100 | 1002.79 | 2001.68 | 2005.12 | 50 | 10 | 1805 |
| 250 | 2604.18 | 4807.66 | 5007.57 | 50 | 10 | 4808 |

### 4. Async AI jobs through a single `JobQueueWorker` (200 ms/job)

| Concurrent artists | p50 ms | p95 ms | p99 ms | jobs/s | Max in-flight | Max queue wait ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 199.78 | 199.78 | 199.78 | 5 | 1 | 0 |
| 10 | 1002.09 | 2004.24 | 2004.24 | 5 | 1 | 1804 |
| 50 | 5008.18 | 9619.92 | 10020.64 | 5 | 1 | 9820 |
| 100 | 10017.29 | 19035.39 | 19837.13 | 5 | 1 | 19837 |
| 250 | 25046.83 | 47689.52 | 49693.24 | 5 | 1 | 49894 |

Heap used at the end of the run: 26.5 MB.

## Findings

- **The abstraction itself is not a bottleneck.** With an instant provider,
  250 concurrent artists see ~1.3 ms p50 and under 4 ms p99. That cost is
  event-loop scheduling, not work done by the abstraction. Throughput stays
  around 100k calls/s.
- **Synchronous AI calls have no backpressure.** Scenario 2 shows that
  in-flight calls at the provider always equal the number of concurrent
  requests: 250 artists means 250 simultaneous provider calls. Nothing in
  `AIProviderService` or `getAiProvider()` limits concurrency or applies a
  timeout.
- **When the provider pushes back, requests pile up in-process.** In scenario
  3, throughput is capped at `cap / latency` (50 calls/s) and p99 grows
  linearly: about 5 s at 250 artists with a 200 ms provider. With a real
  multi-second model latency, queued HTTP requests would hit the 30 s request
  timeout set in `src/app.ts` long before the provider answers. Nothing sheds
  load early, and the existing fail-open fallbacks (empty tag suggestions,
  keyword playlist fallback) never get a chance to run.
- **Async AI jobs are processed one at a time.** Scenario 4 is the largest
  bottleneck. Throughput is fixed at `1 / latency` per worker process (5
  jobs/s at 200 ms), and the last artist waits `N × latency`: about 50 s for
  250 artists at 200 ms. At a realistic 10–20 s per cover image, that becomes
  roughly 40–80 minutes. AI jobs also share this single loop with every other
  `JobQueueService` job type, so a burst of AI requests delays unrelated
  background work, and the reverse is true too.

## Follow-up issues

The two bottlenecks above are drafted as follow-up issues:

1. **Run AI jobs with bounded parallelism in `JobQueueWorker`.** Let a worker
   process run up to `JOB_WORKER_CONCURRENCY` jobs at once (or give AI job
   types their own pool) so async AI throughput scales with provider capacity
   instead of being fixed at one job at a time. Acceptance: scenario 4 p99 at
   250 artists drops proportionally to the configured concurrency, and
   non-AI jobs are not starved by an AI burst.
2. **Add concurrency limits and timeouts to synchronous AI calls.** Put a
   bounded semaphore and a per-call timeout around `AIProviderService` /
   `AiProvider` calls, configurable per feature. Calls that cannot start
   within the timeout should fail fast into the existing fail-open fallbacks
   instead of holding an HTTP request open. Acceptance: scenario 3 p99 stays
   under the configured timeout at 250 artists, and the overflow is counted
   in a metric.
