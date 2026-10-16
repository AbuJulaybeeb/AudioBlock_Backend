/**
 * Load Test Script: AI abstraction latency under concurrent load
 *
 * Implements Issue #299:
 * Simulates many artists triggering AI features at the same time, against
 * the shared fake provider from tests/helpers/fakeAi.ts (#287) — no network
 * call, no API key. Measures latency percentiles, throughput, how many calls
 * reach the provider at once (backpressure), and how long requests wait in
 * a queue before the provider sees them.
 *
 * Scenarios:
 *   1. overhead    — zero-latency provider: cost of the abstraction itself
 *                    (TagSuggestionService -> AIProviderService -> adapter).
 *   2. sync        — synchronous AI features with a realistic provider
 *                    latency and no provider-side limit.
 *   3. sync-capped — same, but the provider only serves N calls at a time
 *                    (vendor concurrency/rate limit); excess calls queue.
 *   4. async-jobs  — slow AI features (cover art, descriptions, lyric
 *                    transcription) as processed by JobQueueWorker, which
 *                    runs one job at a time per worker process.
 *
 * Results for the default settings are recorded in docs/AI_LOAD_TESTING.md.
 *
 * Usage:
 *   npm run benchmark:ai
 *   AI_BENCH_LATENCY_MS=500 AI_BENCH_CONCURRENCY=10,100 npm run benchmark:ai
 *   npx ts-node --transpile-only scripts/load-test-ai-concurrency.ts
 *
 * Env:
 *   AI_BENCH_CONCURRENCY   comma-separated concurrent-artist levels (default 1,10,50,100,250)
 *   AI_BENCH_LATENCY_MS    simulated provider latency per call (default 200)
 *   AI_BENCH_PROVIDER_CAP  provider-side concurrency limit for sync-capped (default 10)
 *   AI_BENCH_OVERHEAD_CALLS calls per level in the overhead scenario (default 2000)
 *   AI_BENCH_SCENARIOS     comma-separated subset of scenarios to run (default all)
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

import { performance } from 'perf_hooks';
import { TagSuggestionService } from '../src/services/TagSuggestionService';
import {
  AIProviderService,
  GenerateTextOptions,
  GenerateTextResult,
} from '../src/services/AI/AIProviderService';
import { FakeAIAdapter, FakeAiProvider } from '../tests/helpers/fakeAi';

const intList = (value: string | undefined, fallback: number[]) =>
  value
    ? value
        .split(',')
        .map((v) => parseInt(v.trim(), 10))
        .filter((n) => n > 0)
    : fallback;

const config = {
  levels: intList(process.env.AI_BENCH_CONCURRENCY, [1, 10, 50, 100, 250]),
  latencyMs: parseInt(process.env.AI_BENCH_LATENCY_MS || '200', 10),
  providerCap: parseInt(process.env.AI_BENCH_PROVIDER_CAP || '10', 10),
  overheadCalls: parseInt(process.env.AI_BENCH_OVERHEAD_CALLS || '2000', 10),
  scenarios: (process.env.AI_BENCH_SCENARIOS || 'overhead,sync,sync-capped,async-jobs').split(','),
};

interface Row {
  concurrency: number;
  calls: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  throughput: number;
  maxInFlight: number;
  maxQueueWait: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(
  concurrency: number,
  durations: number[],
  wallMs: number,
  maxInFlight: number,
  queueWaits: number[] = [],
): Row {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    concurrency,
    calls: durations.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    throughput: durations.length / (wallMs / 1000),
    maxInFlight,
    maxQueueWait: queueWaits.length ? Math.max(...queueWaits) : 0,
  };
}

/**
 * Adapter wrapper that only lets `cap` calls through to the inner adapter at
 * once — models a vendor's concurrency limit. Excess calls wait in a FIFO
 * queue with no timeout, which is exactly what the current abstraction does
 * when a provider is slow: callers simply await longer.
 */
class CappedAdapter extends FakeAIAdapter {
  private active = 0;
  private waiting: Array<() => void> = [];
  readonly queueWaits: number[] = [];

  constructor(
    private inner: FakeAIAdapter,
    private cap: number,
  ) {
    super();
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const queuedAt = performance.now();
    if (this.active >= this.cap) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    this.queueWaits.push(performance.now() - queuedAt);
    try {
      return await this.inner.generateText(options);
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const tagJson = JSON.stringify({ genres: ['Afrobeats'], tags: ['dance', 'summer'] });

/** `concurrency` artists each request tag suggestions at the same moment. */
async function runSyncLevel(
  concurrency: number,
  adapter: FakeAIAdapter,
  callsPerArtist = 1,
): Promise<{ durations: number[]; wallMs: number }> {
  const service = new TagSuggestionService(new AIProviderService(adapter));
  const durations: number[] = [];

  const artist = async (i: number) => {
    for (let n = 0; n < callsPerArtist; n++) {
      const start = performance.now();
      const result = await service.suggestTagsAndGenres({
        title: `Track ${i}-${n}`,
        description: 'Benchmark track',
      });
      durations.push(performance.now() - start);
      if (result.tags.length === 0) throw new Error('fake provider returned no tags');
    }
  };

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => artist(i)));
  return { durations, wallMs: performance.now() - wallStart };
}

async function scenarioOverhead(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const level of config.levels) {
    const adapter = new FakeAIAdapter({ textResponse: tagJson });
    const perArtist = Math.max(1, Math.round(config.overheadCalls / level));
    const { durations, wallMs } = await runSyncLevel(level, adapter, perArtist);
    rows.push(summarize(level, durations, wallMs, adapter.maxInFlight));
  }
  return rows;
}

async function scenarioSync(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const level of config.levels) {
    const adapter = new FakeAIAdapter({ textResponse: tagJson, latencyMs: config.latencyMs });
    const { durations, wallMs } = await runSyncLevel(level, adapter);
    rows.push(summarize(level, durations, wallMs, adapter.maxInFlight));
  }
  return rows;
}

async function scenarioSyncCapped(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const level of config.levels) {
    const inner = new FakeAIAdapter({ textResponse: tagJson, latencyMs: config.latencyMs });
    const capped = new CappedAdapter(inner, config.providerCap);
    const { durations, wallMs } = await runSyncLevel(level, capped);
    rows.push(summarize(level, durations, wallMs, inner.maxInFlight, capped.queueWaits));
  }
  return rows;
}

/**
 * Models JobQueueWorker: `concurrency` artists enqueue a cover-art job at the
 * same moment; a single worker loop reserves and runs one job at a time
 * (see startJobQueueWorker in src/workers/JobQueueWorker.ts). Latency is
 * measured from enqueue to completion, which is what the artist experiences.
 */
async function scenarioAsyncJobs(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const level of config.levels) {
    const provider = new FakeAiProvider({ latencyMs: config.latencyMs });
    const enqueuedAt = performance.now();
    const queue = Array.from({ length: level }, (_, i) => ({ songId: `song-${i}`, enqueuedAt }));
    const durations: number[] = [];
    const queueWaits: number[] = [];

    while (queue.length > 0) {
      const job = queue.shift()!;
      queueWaits.push(performance.now() - job.enqueuedAt);
      await provider.generateCoverArt({ songId: job.songId, title: 'Benchmark track' });
      durations.push(performance.now() - job.enqueuedAt);
    }

    const wallMs = performance.now() - enqueuedAt;
    rows.push(summarize(level, durations, wallMs, provider.maxInFlight, queueWaits));
  }
  return rows;
}

const fmt = (n: number, digits = 1) => n.toFixed(digits);

function printTable(title: string, rows: Row[], showQueue = false): void {
  console.log(`\n### ${title}\n`);
  const header = [
    'Concurrent artists',
    'Calls',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'max ms',
    'calls/s',
    'Max in-flight at provider',
  ];
  if (showQueue) header.push('Max queue wait ms');
  console.log(`| ${header.join(' | ')} |`);
  console.log(`| ${header.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    const cells = [
      r.concurrency,
      r.calls,
      fmt(r.p50, 2),
      fmt(r.p95, 2),
      fmt(r.p99, 2),
      fmt(r.max, 2),
      fmt(r.throughput, 0),
      r.maxInFlight,
    ];
    if (showQueue) cells.push(fmt(r.maxQueueWait, 0));
    console.log(`| ${cells.join(' | ')} |`);
  }
}

async function main(): Promise<void> {
  console.log('# AI abstraction concurrency benchmark (Issue #299)');
  console.log(
    `\nNode ${process.version} · provider latency ${config.latencyMs} ms · provider cap ${config.providerCap} · levels ${config.levels.join(', ')}`,
  );

  const has = (name: string) => config.scenarios.includes(name);

  if (has('overhead')) {
    printTable(
      `1. Abstraction overhead (zero-latency provider, ~${config.overheadCalls} calls per level)`,
      await scenarioOverhead(),
    );
  }
  if (has('sync')) {
    printTable(
      `2. Synchronous AI features, uncapped provider (${config.latencyMs} ms/call)`,
      await scenarioSync(),
    );
  }
  if (has('sync-capped')) {
    printTable(
      `3. Synchronous AI features, provider limited to ${config.providerCap} concurrent calls`,
      await scenarioSyncCapped(),
      true,
    );
  }
  if (has('async-jobs')) {
    printTable(
      `4. Async AI jobs through a single JobQueueWorker (${config.latencyMs} ms/job)`,
      await scenarioAsyncJobs(),
      true,
    );
  }

  const mem = process.memoryUsage();
  console.log(`\nHeap used at end: ${fmt(mem.heapUsed / 1024 / 1024)} MB`);
}

main().catch((err) => {
  console.error('AI concurrency benchmark failed:', err);
  process.exit(1);
});
