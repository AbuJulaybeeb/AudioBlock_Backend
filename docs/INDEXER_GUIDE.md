# Indexer Guide

## Overview

The AudioBlock indexer tracks blockchain events from Stellar/Soroban smart contracts and maintains a queryable database of on-chain activity. It supports multi-network operation (mainnet + testnet), graceful shutdown, RPC monitoring, and historical replay capabilities.

**Related Documentation:**

- [ADR-010: Indexer Architecture](./adrs/010-indexer-architecture.md)
- [Indexer Backfill Runbook](./indexer-backfill-runbook.md)

## Subgraph Queries

Subgraph artist and song queries use ID-cursor pagination and pin every page to
the same indexed block. The client checks the block number and hash across pages,
rejects snapshots with indexing errors, and retries an inconsistent snapshot
before returning an error. Transient connection, timeout, rate-limit, and server
errors use bounded exponential backoff; GraphQL and client errors are reported
without retrying.

The query behavior can be tuned with `SUBGRAPH_QUERY_RETRY_ATTEMPTS`,
`SUBGRAPH_QUERY_TIMEOUT_MS`, `SUBGRAPH_QUERY_RETRY_BASE_DELAY_MS`,
`SUBGRAPH_QUERY_PAGE_SIZE`, and `SUBGRAPH_QUERY_CONSISTENCY_RETRIES`.
Defaults are 3 attempts, 5000 ms, 100 ms, 1000 entities, and 1 snapshot retry.
Artist and song queries can fall back to persisted indexed events when enabled;
queries without an event-backed fallback return an error if the subgraph fails.

Configure the query endpoint with `GRAPH_SUBGRAPH_URL` when the full URL is
already available. For gateway-style URLs that include an API key, set
`GRAPH_SUBGRAPH_ENDPOINT_TEMPLATE` with a `{apiKey}` placeholder and store the
secret in `GRAPH_SUBGRAPH_API_KEY`. The backend substitutes and redacts the key
in health output. Deploy tokens are separate from query keys and should live in
CI secrets as `GRAPH_DEPLOY_TOKEN_TESTNET` and `GRAPH_DEPLOY_TOKEN_MAINNET`.

Frequently queried successful subgraph responses are cached in Redis for 30
seconds by default. Set `SUBGRAPH_CACHE_TTL_MS` to change the lifetime or `0` to
disable this cache. Failed responses and RPC fallback results are not cached.

Authenticated clients can use `GET /api/subgraph` for the typed proxy endpoints:
`/artists`, `/songs`, `/sales`, `/transfers`, `/mints`, `/artists/:artistId`,
and `/songs/:songId/engagement`. List endpoints accept `limit` from 1 to 1000
(default 100). `GET /api/subgraph/aggregate` fetches the five list resources in
parallel, and `/api/subgraph/health` reports subgraph health. These endpoints
require the standard bearer-token authentication middleware; arbitrary GraphQL
documents are not accepted.

Prometheus scrapes `GET /metrics`. The indexer exports `indexer_lag_ledgers`
with `network` and contract-ID labels; `monitoring/prometheus-alerts.yml`
raises warning and critical alerts for sustained lag above 1000 and 10000
ledgers respectively, plus a warning if lag metrics disappear. The standalone
worker serves its own registry on `INDEXER_METRICS_PORT` (default `9464`); the
Compose `monitoring`, `observability`, and `full` profiles start the worker and
scrape it on the private service network.

## Quick Start

### 1. Configure Environment Variables

Add contract IDs to your `.env` file:

```bash
# Mainnet contracts
ARTIST_FACET_MAINNET_CONTRACT_ID=CXXX...
SONG_FACET_MAINNET_CONTRACT_ID=CYYY...
ALBUM_FACET_MAINNET_CONTRACT_ID=CZZZ...
MARKETPLACE_FACET_MAINNET_CONTRACT_ID=CAAA...
ROYALTY_FACET_MAINNET_CONTRACT_ID=CBBB...

# Testnet contracts
ARTIST_FACET_TESTNET_CONTRACT_ID=CDDD...
SONG_FACET_TESTNET_CONTRACT_ID=CEEE...
ALBUM_FACET_TESTNET_CONTRACT_ID=CFFF...
MARKETPLACE_FACET_TESTNET_CONTRACT_ID=CGGG...
ROYALTY_FACET_TESTNET_CONTRACT_ID=CHHH...

# RPC endpoints
SOROBAN_RPC_URL_MAINNET=https://soroban-mainnet.stellar.org
SOROBAN_RPC_URL_TESTNET=https://soroban-testnet.stellar.org

# Indexer configuration (optional, these are defaults)
INDEXER_POLL_INTERVAL_MS=5000  # Poll every 5 seconds
INDEXER_BATCH_SIZE=100         # Events per batch
INDEXER_OVERLAP_WINDOW=10      # Reorg protection
```

### 2. Start the Indexer

```bash
npm run worker:indexer
```

The indexer will:

- Load all configured contracts from environment variables
- Start independent poll loops for each contract+network
- Begin processing events and updating cursors
- ntained per contract+network

  **Example:** If testnet RPC goes down, mainnet indexing continues unaffected.

### Graceful Shutdown (Issue #258)

The indexer handles SIGTERM/SIGINT gracefully:

```bash
# Send shutdown signal
kill -TERM <pid>

# Or via Docker/Kubernetes
docker stop audioblock-indexer
kubectl rollout restart deployment/indexer
```

**Behavior:**

1. Stop accepting new batches
2. Finish processing current batch
3. Update cursor to last processed ledger
4. Exit cleanly

**No data loss:** Cursor only advances after batch is fully persisted.

### RPC Monitoring (Issue #257)

The indexer exposes Prometheus metrics for RPC calls:

**Metrics:**

```prometheus
# Total RPC calls by network, method, and status
soroban_rpc_calls_total{network="mainnet", method="getEvents", status="success"} 12543

# RPC call latency histogram
soroban_rpc_latency_seconds{network="mainnet", method="getEvents"} 0.25

# Indexer lag (ledgers behind network head)
indexer_lag_ledgers{network="mainnet", contract="CXXX..."} 5

# Total events processed
indexer_events_processed_total{network="mainnet", contract="CXXX..."} 10523

# Total errors
indexer_errors_total{network="mainnet", contract="CXXX..."} 2
```

**Expected Volume:**

- 5 contracts × 2 networks = 10 poll loops
- Poll interval: 5 seconds
- ~5.2 million RPC calls per month

**Alert Thresholds:**

- Lag > 1000 ledgers: Indexer falling behind
- Error rate > 0.1/sec: RPC or network issues
- P95 latency > 5 seconds: Provider degradation

### Replay/Reindex CLI (Issue #256)

Debug missed events by reindexing a specific ledger range:

```bash
npm run cli:reindex -- \
  --contract CXXX... \
  --network mainnet \
  --from 1000000 \
  --to 1001000
```

**Options:**

- `--contract <ID>` - Contract ID to reindex (required)
- `--network <NETWORK>` - Network: mainnet or testnet (required)
- `--from <LEDGER>` - Start ledger number (required)
- `--to <LEDGER>` - End ledger number (required)
- `--dry-run` - Read-only mode, no database writes (optional)

**Safety Guarantees:**

✅ Does NOT mutate live `indexer_cursors.lastProcessedLedger`
✅ Idempotent: events are upserted, duplicates handled gracefully
✅ Dry-run mode available for validation

**Example Use Cases:**

```bash
# Debug suspected missed event
npm run cli:reindex -- \
  --contract CXXX... \
  --network mainnet \
  --from 1005000 \
  --to 1006000

# Validate indexer logic (dry-run)
npm run cli:reindex -- \
  --contract CXXX... \
  --network testnet \
  --from 500000 \
  --to 501000 \
  --dry-run

# Re-import after malformed event fix
npm run cli:reindex -- \
  --contract CXXX... \
  --network mainnet \
  --from 1003450 \
  --to 1003460
```

## Database Schema

### indexer_cursors

Tracks the last-processed ledger for each contract+network:

```sql
CREATE TABLE indexer_cursors (
  id UUID PRIMARY KEY,
  contract_id VARCHAR(100) NOT NULL,
  network VARCHAR(50) NOT NULL,
  last_processed_ledger BIGINT DEFAULT 0,
  events_processed BIGINT DEFAULT 0,
  error_count BIGINT DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(contract_id, network)
);
```

### indexed_events

Stores processed blockchain events:

```sql
CREATE TABLE indexed_events (
  id UUID PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL,
  network VARCHAR(50) NOT NULL,
  contract_id VARCHAR(100),
  ledger BIGINT,
  event_type VARCHAR(100),
  event_data JSONB,
  tx_hash VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(event_id, network, contract_id)
);
```

## Testing

### Unit tests

`src/__tests__/IndexerWorker.test.ts` covers the worker against a mocked
`SorobanEventReader` (happy path, empty batches, RPC errors) and runs as
part of the normal `npm test` suite, with no network access.

### Integration test against testnet (Issue #249)

`src/__tests__/IndexerWorker.integration.test.ts` polls real testnet RPC for
a configured contract and asserts the decoded event shape. It is skipped by
default — set `RUN_INDEXER_INTEGRATION_TEST=true` to run it locally (testnet
contract IDs and RPC URL must already be configured per "Quick Start" above):

```bash
RUN_INDEXER_INTEGRATION_TEST=true npx jest IndexerWorker.integration
```

## Troubleshooting

### Indexer Not Starting

**Symptom:** No poll loops start, logs show "No contracts configured"

**Solution:** Add contract IDs to environment variables:

```bash
# Check if env vars are set
env | grep FACET

# If missing, add to .env
ARTIST_FACET_MAINNET_CONTRACT_ID=CXXX...
```

### High Lag

**Symptom:** `indexer_lag_ledgers` metric shows >1000 ledgers

**Possible Causes:**

- RPC provider rate limiting
- Network connectivity issues
- Database connection pool exhausted

**Solutions:**

1. Check RPC metrics:

   ```bash
   curl http://localhost:4000/metrics | grep soroban_rpc
   ```

2. Increase poll interval (reduce RPC load):

   ```bash
   INDEXER_POLL_INTERVAL_MS=10000  # Poll every 10 seconds
   ```

3. Check database pool:
   ```bash
   curl http://localhost:4000/metrics | grep db_pool
   ```

### RPC Errors

**Symptom:** High `indexer_errors_total` count, logs show RPC timeouts

**Solution:** The indexer has built-in exponential backoff. Check:

1. RPC provider status
2. Network connectivity
3. Rate limiting headers

**Increase backoff if needed:**

```bash
SOROBAN_BACKOFF_MAX_MS=60000     # Max 60 second backoff
SOROBAN_BACKOFF_MAX_RETRIES=10   # Retry up to 10 times
```

### Cursor Corruption

**Symptom:** Events being re-processed, duplicate entries

**Root Cause:** Indexer crashed mid-batch without advancing cursor

**Prevention:** Graceful shutdown ensures cursor only advances after batch completes

**Recovery:**

1. Check current cursor position:

   ```sql
   SELECT * FROM indexer_cursors WHERE contract_id = 'CXXX...';
   ```

2. Manually advance cursor if needed:

   ```sql
   UPDATE indexer_cursors
   SET last_processed_ledger = 1001000
   WHERE contract_id = 'CXXX...' AND network = 'mainnet';
   ```

3. Restart indexer

### Missing Events

**Symptom:** Expected event not in `indexed_events` table

**Debug Steps:**

1. Check if ledger was processed:

   ```sql
   SELECT last_processed_ledger
   FROM indexer_cursors
   WHERE contract_id = 'CXXX...' AND network = 'mainnet';
   ```

2. Verify event exists on-chain (use Stellar block explorer)

3. Run reindex CLI for the ledger range:

   ```bash
   npm run cli:reindex -- \
     --contract CXXX... \
     --network mainnet \
     --from <LEDGER-10> \
     --to <LEDGER+10> \
     --dry-run
   ```

4. If event found, re-run without `--dry-run` to persist

## Performance Tuning

### Poll Interval

**Default:** 5 seconds

**Tune based on:**

- RPC provider rate limits
- Acceptable lag tolerance
- Network transaction volume

```bash
# Faster indexing (more RPC calls)
INDEXER_POLL_INTERVAL_MS=2000

# Slower indexing (fewer RPC calls)
INDEXER_POLL_INTERVAL_MS=10000
```

### Batch Size

**Default:** 100 events

**Trade-offs:**

- Larger batches: Faster overall, longer recovery on crash
- Smaller batches: Safer, easier to resume, slower

```bash
# Large batches (fast networks with low lag)
INDEXER_BATCH_SIZE=500

# Small batches (high lag or frequent restarts)
INDEXER_BATCH_SIZE=50
```

### Overlap Window

**Default:** 10 ledgers

**Purpose:** Reorg protection - reprocess last N ledgers on each poll

```bash
# More reorg protection (slower)
INDEXER_OVERLAP_WINDOW=20

# Less reorg protection (faster)
INDEXER_OVERLAP_WINDOW=5
```

## Monitoring & Alerts

### Grafana Dashboard

Import the provided dashboard:

```bash
monitoring/dashboards/audioblock-indexer.json
```

**Panels:**

- Indexer lag by network and contract
- RPC call rate and latency
- Error rate
- Events processed per second

### Recommended Alerts

```yaml
# Prometheus alert rules
groups:
  - name: indexer
    rules:
      - alert: IndexerHighLag
        expr: indexer_lag_ledgers > 1000
        for: 5m
        annotations:
          summary: 'Indexer lagging >1000 ledgers'

      - alert: IndexerHighErrorRate
        expr: rate(indexer_errors_total[5m]) > 0.1
        annotations:
          summary: 'Indexer error rate >0.1/sec'

      - alert: RpcHighLatency
        expr: histogram_quantile(0.95, soroban_rpc_latency_seconds) > 5
        annotations:
          summary: 'P95 RPC latency >5 seconds'

      - alert: IndexerDown
        expr: up{job="indexer"} == 0
        for: 1m
        annotations:
          summary: 'Indexer worker is down'
```

## Deployment

### Docker

```dockerfile
# Run indexer as separate service
services:
  indexer:
    build: .
    command: npm run worker:indexer
    environment:
      - ARTIST_FACET_MAINNET_CONTRACT_ID=${ARTIST_FACET_MAINNET_CONTRACT_ID}
      # ... other env vars
    restart: unless-stopped
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: audioblock-indexer
spec:
  replicas: 1 # Single instance per contract set
  template:
    spec:
      containers:
        - name: indexer
          image: audioblock-backend:latest
          command: ['npm', 'run', 'worker:indexer']
          envFrom:
            - configMapRef:
                name: audioblock-config
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'
            limits:
              memory: '1Gi'
              cpu: '1000m'
```

### Health Checks

```bash
# Check if indexer is running
ps aux | grep IndexerWorker

# Check recent progress
curl http://localhost:4000/api/admin/indexer/status | jq '.[] | {contract, network, lag}'

# Check metrics endpoint
curl -s http://localhost:4000/metrics | grep indexer_lag_ledgers
```

## FAQ

### Q: Can I run multiple indexer workers?

**A:** Not recommended for the same contracts. Each contract should be indexed by a single worker to avoid cursor conflicts. However, you can shard contracts across multiple workers if needed.

### Q: What happens if RPC provider goes down?

**A:** The indexer retries with exponential backoff (up to 5 attempts by default). If all retries fail, it logs the error, updates metrics, and waits for the next poll cycle.

### Q: How do I add a new contract?

**A:**

1. Add env var: `NEW_CONTRACT_MAINNET_CONTRACT_ID=CXXX...`
2. Update `IndexerWorker.loadContractConfigs()` to include the new contract type
3. Restart indexer

### Q: Can I pause indexing temporarily?

**A:** Yes, send SIGTERM to stop gracefully, then restart when ready. The cursor will resume from the last processed ledger.

### Q: Does reindex CLI affect production?

**A:** No, it only writes to `indexed_events` (idempotent upserts). The live cursor in `indexer_cursors` is never touched.

## Support

For issues or questions:

- Check logs: `docker logs audioblock-indexer --tail 100`
- Query status: `GET /api/admin/indexer/status`
- Review metrics: http://localhost:3001 (Grafana)
- Open issue: https://github.com/AudioBitsStellar/AudioBlock_Backend/issues
