# Database Connection Pool Alerting

## Overview

The `db_pool_exhausted` Prometheus gauge (#334) is set to `1` when every database connection is in use **and** requests are queued waiting for one, and `0` otherwise. Sustained exhaustion means the pool is undersized for current load and requests are stalling.

## Alert Rules

### DBPoolExhausted

```yaml
groups:
  - name: database
    rules:
      - alert: DBPoolExhausted
        expr: max_over_time(db_pool_exhausted[5m]) == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool is exhausted"
          description: "All DB connections are in use and {{ $value }} request(s) are waiting. Pool size may need to be increased."
          runbook: "https://github.com/AudioBitsStellar/AudioBlock_Backend/blob/main/docs/db-pool-alerting.md#runbook"
```

### DBPoolHighUtilization (warning)

```yaml
      - alert: DBPoolHighUtilization
        expr: db_pool_active / db_pool_total > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Database connection pool utilization above 90%"
          description: "Pool is {{ $value | humanizePercentage }} utilized for 10 minutes. Consider scaling or tuning query concurrency."
          runbook: "https://github.com/AudioBitsStellar/AudioBlock_Backend/blob/main/docs/db-pool-alerting.md#runbook"
```

## Runbook

### DBPoolExhausted

1. **Check current pool state**: `curl http://localhost:PORT/health` — the `pool` section shows active/idle/waiting counts.
2. **Identify slow queries**: Check PostgreSQL `pg_stat_activity` for long-running queries blocking connections.
3. **Scale the pool**: Increase `DB_POOL_MAX` env var and restart. Default is typically 10–20.
4. **Investigate traffic spike**: Check `http_requests_in_flight` and recent deploy history.
5. **If sustained**: Consider adding read replicas or query caching to reduce DB load.

### DBPoolHighUtilization

1. Monitor trend — if rising steadily, plan a pool increase before exhaustion.
2. Review recent query patterns for N+1 or missing indexes.
3. Consider enabling the manifest cache (`MANIFEST_CACHE_TTL`) to reduce DB reads.

## Verification

To simulate high utilization and verify the alert fires:

```bash
# Run the load test against a local instance
npm run load-test -- --connections 50 --duration 60
# Then check: curl localhost:PORT/metrics | grep db_pool_exhausted
```

## Related Metrics

| Metric | Description |
|--------|-------------|
| `db_pool_active` | Connections currently in use |
| `db_pool_idle` | Connections available for use |
| `db_pool_waiting` | Requests queued for a connection |
| `db_pool_exhausted` | 1 when exhausted (all in use + waiting) |
