/**
 * Prometheus metrics for monitoring HTTP requests, database pool, uploads,
 * royalties, marketplace volume, cache performance, and blockchain indexer health.
 *
 * Indexer metrics (Issues #241, #242):
 * - indexer_lag_ledgers: Ledgers behind latest Stellar ledger (by network/contract)
 * - indexer_events_processed_total: Total blockchain events processed
 * - indexer_errors_total: Total indexer errors
 *
 * See monitoring/dashboards/audioblock-indexer.json for visualization.
 */
import client from 'prom-client';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP request count',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsActive = new client.Gauge({
  name: 'http_requests_active',
  help: 'Number of HTTP requests currently in flight',
  registers: [register],
});

export const dbPoolActive = new client.Gauge({
  name: 'db_pool_active',
  help: 'Number of active database connections',
  registers: [register],
});

export const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle',
  help: 'Number of idle database connections',
  registers: [register],
});

export const dbPoolWaiting = new client.Gauge({
  name: 'db_pool_waiting',
  help: 'Number of queued requests waiting for a database connection',
  registers: [register],
});

/** #334 — 1 when the pool is exhausted (all connections in use AND callers waiting). */
export const dbPoolExhausted = new client.Gauge({
  name: 'db_pool_exhausted',
  help: '1 when DB pool is exhausted (active >= max AND waiting > 0), else 0',
  registers: [register],
});

export const songsUploadedTotal = new client.Counter({
  name: 'songs_uploaded_total',
  help: 'Total number of songs uploaded',
  registers: [register],
});

export const royaltiesPaidTotal = new client.Counter({
  name: 'royalties_paid_total',
  help: 'Total number of royalty payouts recorded',
  registers: [register],
});

export const marketplaceVolumeStroops = new client.Counter({
  name: 'marketplace_volume_stroops_total',
  help: 'Total marketplace volume in stroops',
  registers: [register],
});

export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  registers: [register],
});

export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  registers: [register],
});

// ── Indexer metrics (Issue #241) ────────────────────────────────────────────

export const indexerLagLedgers = new client.Gauge({
  name: 'indexer_lag_ledgers',
  help: 'Number of ledgers behind the latest Stellar ledger',
  labelNames: ['network', 'contract'] as const,
  registers: [register],
});

// ── Privy auth metrics (Issues #634, #635) ─────────────────────────────────────

export const privyJwkFetchesTotal = new client.Counter({
  name: 'privy_jwk_fetches_total',
  help: 'Total JWKS fetches from the Privy API, by outcome',
  labelNames: ['outcome'] as const, // 'success' | 'failure' | 'stale_served'
  registers: [register],
});

export const privyJwkCacheHitsTotal = new client.Counter({
  name: 'privy_jwk_cache_hits_total',
  help: 'Total Privy public key lookups served from the local cache',
  registers: [register],
});

export const privyJwkCacheMissesTotal = new client.Counter({
  name: 'privy_jwk_cache_misses_total',
  help: 'Total Privy public key lookups that required a JWKS fetch',
  registers: [register],
});

export const privyJwkUnknownKidTotal = new client.Counter({
  name: 'privy_jwk_unknown_kid_total',
  help: 'Total token verifications rejected because the signing key id was absent from the JWKS',
  registers: [register],
});

export const privyTokenVerificationsTotal = new client.Counter({
  name: 'privy_token_verifications_total',
  help: 'Total Privy access token verification attempts, by outcome',
  labelNames: ['outcome'] as const, // 'success' | 'invalid' | 'unavailable'
  registers: [register],
});

export const privyAuthFallbacksTotal = new client.Counter({
  name: 'privy_auth_fallbacks_total',
  help: 'Total requests that fell back to legacy auth after a Privy availability failure',
  registers: [register],
});

export const authFailuresTotal = new client.Counter({
  name: 'auth_failures_total',
  help: 'Total authentication failures by type',
  labelNames: ['auth_method', 'failure_type'] as const, // auth_method: 'legacy'|'privy', failure_type: 'invalid_token'|'expired'|'revoked'|'unavailable'
  registers: [register],
});

export const rateLimitFallbacksTotal = new client.Counter({
  name: 'rate_limit_fallbacks_total',
  help: 'Total requests handled by a rate limiter fallback because Redis was unavailable',
  labelNames: ['limiter', 'mode'] as const, // mode: 'open'|'closed'|'memory'
  registers: [register],
});

export const privyCircuitState = new client.Gauge({
  name: 'privy_circuit_state',
  help: 'Current state of the Privy circuit breaker (1 for the active state, 0 otherwise)',
  labelNames: ['state'] as const, // 'closed' | 'open' | 'half_open'
  registers: [register],
});

export const indexerEventsProcessedTotal = new client.Counter({
  name: 'indexer_events_processed_total',
  help: 'Total number of blockchain events processed by the indexer',
  labelNames: ['network', 'contract'] as const,
  registers: [register],
});

export const indexerErrorsTotal = new client.Counter({
  name: 'indexer_errors_total',
  help: 'Total number of indexer errors',
  labelNames: ['network', 'contract'] as const,
  registers: [register],
});

// ── Soroban RPC metrics (Issue #257) ────────────────────────────────────────

export const sorobanRpcCallsTotal = new client.Counter({
  name: 'soroban_rpc_calls_total',
  help: 'Total number of Soroban RPC calls',
  labelNames: ['network', 'method', 'status'] as const,
  registers: [register],
});

export const sorobanRpcLatencySeconds = new client.Histogram({
  name: 'soroban_rpc_latency_seconds',
  help: 'Soroban RPC call latency in seconds',
  labelNames: ['network', 'method'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// ── RabbitMQ queue metrics (Issue #377) ──────────────────────────────────────

export const rabbitmqQueueDepth = new client.Gauge({
  name: 'rabbitmq_queue_depth',
  help: 'Current number of messages in the RabbitMQ queue (queue depth)',
  labelNames: ['queue'] as const,
  registers: [register],
});

/**
 * Update the Prometheus gauge reflecting the current RabbitMQ queue depth.
 *
 * @param queue - The queue name (e.g. 'song_processing')
 * @param depth - The number of pending/waiting messages in the queue
 */
export function updateRabbitMQQueueDepth(queue: string, depth: number): void {
  rabbitmqQueueDepth.set({ queue }, Math.max(0, depth));
}

/**
 * Poll and record the depth for a given RabbitMQ queue using an active channel.
 *
 * @param channel - RabbitMQ channel with checkQueue capability
 * @param queueName - The queue name (defaults to 'song_processing')
 * @returns The current message count (queue depth)
 */
export async function collectQueueDepth(
  channel: {
    checkQueue: (name: string) => Promise<{ messageCount: number; consumerCount: number }>;
  },
  queueName: string = 'song_processing',
): Promise<number> {
  const info = await channel.checkQueue(queueName);
  rabbitmqQueueDepth.set({ queue: queueName }, info.messageCount);
  return info.messageCount;
}

/**
 * Update the Prometheus gauges reflecting the current PostgreSQL connection
 * pool state.
 *
 * @param pool - Object with totalCount, idleCount, and waitingCount from pg Pool.
 */
export async function updateDbPoolMetrics(pool: {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}): Promise<void> {
  const active = pool.totalCount - pool.idleCount;
  dbPoolActive.set(active);
  dbPoolIdle.set(pool.idleCount);
  dbPoolWaiting.set(pool.waitingCount);
  // #334 — 1 when the pool is exhausted (all connections in use AND callers
  // waiting), 0 otherwise. Sustained 1 triggers the DB pool alert.
  const exhausted = pool.waitingCount > 0 && active >= pool.totalCount ? 1 : 0;
  dbPoolExhausted.set(exhausted);
}

/**
 * Get the content type string for the Prometheus metrics endpoint.
 *
 * @returns Content type (e.g. "text/plain; version=0.0.4; charset=utf-8").
 */
export async function getMetricsContentType(): Promise<string> {
  return register.contentType;
}

/**
 * Serialize all registered Prometheus metrics to the text exposition format.
 *
 * @returns Metrics payload string for the /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}
