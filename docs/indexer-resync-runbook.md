# Indexer Resync / Redeployment Runbook

This runbook covers operational incidents where the AudioBlock indexer worker
needs to be resynced or redeployed: a lagging indexer, a crashed worker, a
contract redeployment on a new address, or a database reset. For **historical
backfill** of pre-indexer data, see
[indexer-backfill-runbook.md](./indexer-backfill-runbook.md).

---

## Decision tree

```
Indexer alert fires
       │
       ├─ Lag > 1000 ledgers but worker is running? ──► Section 1: Catch-up resync
       │
       ├─ Worker crashed / pod not running?         ──► Section 2: Worker restart
       │
       ├─ Contract redeployed to new address?       ──► Section 3: Contract address update
       │
       ├─ Database reset or cursor table wiped?     ──► Section 4: Cursor recovery
       │
       └─ Rolling deploy causing duplicate events?  ──► Section 5: Safe redeployment procedure
```

---

## 1. Catch-up resync (indexer is running but lagging)

**Symptoms:**
- Grafana alert: `IndexerLagHigh` — `indexer_lag_ledgers > 1000` for 5+ minutes
- `GET /api/admin/indexer/status` shows `lagLedgers > 1000`
- RPC latency is normal (P95 < 5s)

**Cause:** Usually a temporary RPC provider slowdown, a deploy that paused the
worker, or a burst of on-chain activity.

**Resolution:**

```bash
# 1. Check current lag per contract
GET /api/admin/indexer/status

# 2. Check worker logs for errors
docker logs audioblock_indexer --tail 100 --follow
# or on Kubernetes:
kubectl logs deployment/indexer --tail=100 -f

# 3. If no errors — the worker is catching up on its own.
#    Wait 10–15 minutes and re-check the Grafana lag panel.
#    Normal catch-up speed is ~200 ledgers/second with batch-size 100.

# 4. If errors are present (e.g. RPC timeouts), check the RPC endpoint:
curl -X POST $SOROBAN_RPC_URL_MAINNET \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
# Expected: {"status":"healthy"}

# 5. If the RPC is healthy but lag is not recovering after 30 minutes,
#    restart the worker to clear any stalled poll loops:
docker restart audioblock_indexer
# or:
kubectl rollout restart deployment/indexer
```

**Expected outcome:** Lag drops back below 100 ledgers within 10–30 minutes
after the worker resumes normal polling.

---

## 2. Worker restart after crash

**Symptoms:**
- Grafana alert: `IndexerLagHigh` sustained
- Worker pod is in `CrashLoopBackOff` or container has exited
- `GET /api/admin/indexer/status` times out or returns 503

**Cause:** OOM kill, uncaught exception, or infrastructure fault.

**Resolution:**

```bash
# 1. Check exit code and last logs
docker inspect audioblock_indexer --format '{{.State.ExitCode}}'
docker logs audioblock_indexer --tail 200

# On Kubernetes:
kubectl describe pod -l app=indexer
kubectl logs -l app=indexer --previous

# 2. If OOM (exit code 137):
#    - Increase memory limit in docker-compose.prod.yml or the k8s Deployment.
#    - Reduce INDEXER_BATCH_SIZE (default 100 → 50) to lower per-batch memory.

# 3. Restart the worker
docker start audioblock_indexer
# or:
kubectl rollout restart deployment/indexer

# 4. Verify cursor integrity — the worker should resume from the last
#    committed cursor, not from ledger 0.
psql $DATABASE_URL -c "
  SELECT contract_id, network, last_processed_ledger, error_count, last_error
  FROM indexer_cursors
  ORDER BY updated_at DESC;"
```

**Cursor is safe:** The worker only advances `last_processed_ledger` after a
batch is fully persisted. A crash mid-batch re-processes the same batch on
restart (events are upserted, so duplicates are harmless).

---

## 3. Contract redeployed to a new address

**Symptoms:**
- A Soroban contract was redeployed (new contract ID)
- Old contract address no longer emitting events
- `GET /api/admin/indexer/status` shows the old contract stuck at the
  deployment ledger of the new one

**Resolution:**

```bash
# 1. Update environment variables with the new contract ID
#    In .env / Kubernetes secret / ECS task definition:
SONG_FACET_MAINNET_CONTRACT_ID=<NEW_CONTRACT_ID>

# 2. Optionally reset the cursor for the old contract so the indexer
#    does not keep polling a dead address:
psql $DATABASE_URL -c "
  DELETE FROM indexer_cursors
  WHERE contract_id = '<OLD_CONTRACT_ID>'
  AND network = 'mainnet';"

# 3. Redeploy the indexer worker so it picks up the new env var.
docker-compose -f docker-compose.prod.yml up -d --no-deps indexer
# or:
kubectl rollout restart deployment/indexer

# 4. If the new contract has events from before the indexer start ledger,
#    run a backfill for the gap:
npm run cli -- backfill:run \
  --contract <NEW_CONTRACT_ID> \
  --network mainnet \
  --start <DEPLOYMENT_LEDGER> \
  --end <CURRENT_LEDGER>
```

---

## 4. Cursor recovery after database reset

**Symptoms:**
- Database was wiped or `indexer_cursors` table was truncated
- Worker restarts from ledger 0 and is processing millions of historical ledgers
- `indexed_events` table is being flooded with old events

**Resolution (fastest — skip historical events):**

```bash
# 1. Stop the indexer immediately to avoid unnecessary RPC calls
docker stop audioblock_indexer
# or:
kubectl scale deployment/indexer --replicas=0

# 2. Find the current ledger sequence on each network
curl -s -X POST https://soroban-mainnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | jq '.result.sequence'

curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | jq '.result.sequence'

# 3. Pre-seed cursors to the current ledger so the worker starts
#    from "now" instead of replaying all history.
#    Adjust CURRENT_LEDGER_MAINNET and CURRENT_LEDGER_TESTNET from step 2.
psql $DATABASE_URL <<'SQL'
INSERT INTO indexer_cursors
  (id, contract_id, network, last_processed_ledger, events_processed, error_count)
VALUES
  (gen_random_uuid(), '<ARTIST_MAINNET_ID>',      'mainnet', CURRENT_LEDGER_MAINNET, 0, 0),
  (gen_random_uuid(), '<SONG_MAINNET_ID>',        'mainnet', CURRENT_LEDGER_MAINNET, 0, 0),
  (gen_random_uuid(), '<ALBUM_MAINNET_ID>',       'mainnet', CURRENT_LEDGER_MAINNET, 0, 0),
  (gen_random_uuid(), '<MARKETPLACE_MAINNET_ID>', 'mainnet', CURRENT_LEDGER_MAINNET, 0, 0),
  (gen_random_uuid(), '<ROYALTY_MAINNET_ID>',     'mainnet', CURRENT_LEDGER_MAINNET, 0, 0),
  (gen_random_uuid(), '<ARTIST_TESTNET_ID>',      'testnet', CURRENT_LEDGER_TESTNET, 0, 0),
  (gen_random_uuid(), '<SONG_TESTNET_ID>',        'testnet', CURRENT_LEDGER_TESTNET, 0, 0),
  (gen_random_uuid(), '<ALBUM_TESTNET_ID>',       'testnet', CURRENT_LEDGER_TESTNET, 0, 0),
  (gen_random_uuid(), '<MARKETPLACE_TESTNET_ID>', 'testnet', CURRENT_LEDGER_TESTNET, 0, 0),
  (gen_random_uuid(), '<ROYALTY_TESTNET_ID>',     'testnet', CURRENT_LEDGER_TESTNET, 0, 0)
ON CONFLICT (contract_id, network) DO UPDATE
  SET last_processed_ledger = EXCLUDED.last_processed_ledger,
      events_processed = 0,
      error_count = 0,
      updated_at = NOW();
SQL

# 4. Start the indexer
docker start audioblock_indexer
# or:
kubectl scale deployment/indexer --replicas=1

# 5. If historical data is also needed, run the backfill separately
#    (see indexer-backfill-runbook.md) after the worker is stable.
```

---

## 5. Safe rolling redeployment procedure

Follow this order to avoid duplicate-event spikes or cursor corruption during
a planned deploy.

```
1. Send SIGTERM to the running worker
         │
         │   Worker finishes current batch and persists cursor
         │   (takes up to ~30s for a 100-event batch)
         ▼
2. Verify clean shutdown
         │
         │   Check logs for: "Indexer worker shutdown complete"
         │   or wait for container exit code 0
         ▼
3. Deploy the new worker image
         │
         │   docker-compose pull indexer && docker-compose up -d indexer
         │   or: kubectl set image deployment/indexer indexer=<NEW_IMAGE>
         ▼
4. Verify the new worker resumes from the correct ledger
         │
         │   Check logs for the startup message showing last_processed_ledger
         │   Compare against psql: SELECT last_processed_ledger FROM indexer_cursors;
         ▼
5. Confirm lag is recovering on Grafana within 5 minutes
```

**What to avoid:**

- **Do not** `docker kill` (SIGKILL) — this skips the graceful shutdown and
  may leave the cursor behind by up to one batch.
- **Do not** run two worker instances simultaneously against the same database
  — parallel writes to `indexer_cursors` can cause cursor drift.
- **Do not** restart the worker while a backfill CLI command is in progress —
  both processes update the same `indexer_cursors` row.

---

## Verification checklist (post-incident)

After any resync or redeployment, confirm all of the following:

```bash
# 1. Lag is below 100 ledgers on all contracts
GET /api/admin/indexer/status

# 2. No error spike in the last 15 minutes
# Grafana: indexer_errors_total rate(5m) < 0.1

# 3. Cursors are advancing (run twice, 30s apart)
psql $DATABASE_URL -c "
  SELECT contract_id, network, last_processed_ledger, updated_at
  FROM indexer_cursors ORDER BY network, contract_id;"

# 4. Events are being written
psql $DATABASE_URL -c "
  SELECT network, contract_id, COUNT(*) AS events, MAX(created_at) AS latest
  FROM indexed_events
  GROUP BY network, contract_id
  ORDER BY latest DESC;"
```

---

## Escalation

If the indexer cannot recover after following this runbook:

1. Check [ADR-010](./adrs/010-indexer-architecture.md) for architecture context.
2. Check the Grafana dashboard at `http://localhost:3001` (or the production URL).
3. Open an incident issue: https://github.com/AudioBitsStellar/AudioBlock_Backend/issues
4. For RPC provider issues, check the provider's status page and consider
   switching `SOROBAN_RPC_URL_MAINNET` to a backup endpoint.

---

## Related docs

- [Indexer Guide](./INDEXER_GUIDE.md)
- [Indexer Backfill Runbook](./indexer-backfill-runbook.md) — historical data import
- [ADR-010: Indexer Architecture](./adrs/010-indexer-architecture.md)
- [Deployment & Scaling Guide](./deployment-and-scaling.md)


### Reindex a bounded range

Run `npm run cli:reindex -- --contract <REGISTERED_CONTRACT_ID> --network testnet --from 100 --to 200 --dry-run` first, then omit `--dry-run` to persist. Both endpoints are inclusive. The contract must be configured in IndexerContractRegistry for the requested network; set the SOROBAN_TESTNET_*_CONTRACT_ID or SOROBAN_MAINNET_*_CONTRACT_ID variables and the corresponding SOROBAN_*_RPC_URL.

The CLI uses the live indexer's reader and decoders and follows RPC cursors, including multiple pages within a single ledger. It leaves the live cursor untouched. Dry runs decode and count by event type without connecting to the database. The summary reports fetched, inserted, alreadyPresent, failed, skipped (unknown event types), and perType counts. Replaying a range is idempotent. Event failures produce a nonzero exit status; RPC errors abort the run. If the RPC has pruned the requested history, use an RPC provider retaining that range.
