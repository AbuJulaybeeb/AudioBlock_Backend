# Monitoring — Dashboard-as-Code

This directory holds the monitoring configuration for AudioBlock Backend as
version-controlled code (Issue #382). Nothing here has to be exported by hand
from a running Grafana — every dashboard lives in this repo as JSON and is
provisioned automatically on container startup.

## Layout

```
monitoring/
├── prometheus.yml        # Prometheus scrape config (targets the backend /metrics)
├── promtail.yml          # Promtail log shipping config (targets Loki) (Issue #380)
├── grafana/
│   └── provisioning.yml  # Grafana provisioning: Prometheus & Loki datasources + dashboards provider
└── dashboards/
    ├── audioblock-app.json   # Express app / HTTP / DB-pool / cache / royalties dashboard
    └── audioblock-node.json  # Host system (CPU / memory / disk / network) overview
```

## How it works

`docker-compose.yml` starts Prometheus, Grafana, Grafana Loki, and Promtail.

- Prometheus scrapes the backend's `GET /metrics` endpoint (exposed by
  `prom-client` in `src/services/MetricsService.ts`, served by
  `src/routes/metricsRoutes.ts`) using
  `./monitoring/prometheus.yml`.
- The standalone indexer worker serves its process-local metrics on port 9464;
  the `monitoring`, `observability`, and `full` Compose profiles start it and
  let Prometheus scrape `indexer:9464`.
- Log aggregation is handled by Grafana Loki and Promtail (Issue #380):
  Promtail collects container stdout JSON logs, redacts any sensitive tokens,
  and ships them to Loki at `http://loki:3100`. See
  [`docs/logging-and-aggregation.md`](../docs/logging-and-aggregation.md) for
  the complete runbook and LogQL query examples.
- Grafana is provisioned entirely from disk:
  - `./monitoring/grafana/provisioning.yml` is mounted to
    `/etc/grafana/provisioning/provisioning.yml` — it defines the Prometheus
    and Loki datasources and a file-based dashboard provider.
  - `./monitoring/dashboards/` is mounted to
    `/etc/grafana/provisioning/dashboards` — this is the provider's
    `path`, so every dashboard JSON in the directory is automatically loaded.

Any dashboard JSON added to `monitoring/dashboards/` is picked up by Grafana
within `updateIntervalSeconds` (10s) — no manual import required.

## The dashboards

### `audioblock-app.json`

Visualisations of the application metrics emitted by `MetricsService`:

- `http_requests_total` (rate by method, and 5xx by route)
- `http_request_duration_seconds` (histogram → p95 / p99)
- `http_requests_active`
- `db_pool_active` / `db_pool_idle` / `db_pool_waiting`
- `songs_uploaded_total`
- `cache_hits_total` / `cache_misses_total`
- `marketplace_volume_stroops_total`
- `royalties_paid_total`
- `rabbitmq_queue_depth` (queue depth by queue name, e.g. `song_processing`, Issue #377)

### Queue Depth Alerting (Issue #377)

Alert rules configured in `monitoring/prometheus-alerts.yml` under group `audioblock-rabbitmq`:

- `SongProcessingQueueBacklog`: Fires when `rabbitmq_queue_depth{queue="song_processing"} > 10` for 5 minutes (warning). Indicates worker crash, stalled consumer, or FFmpeg unavailability.
- `CriticalSongProcessingQueueBacklog`: Fires when `rabbitmq_queue_depth{queue="song_processing"} > 50` for 10 minutes (critical). Requires immediate worker scaling or restart.

### `audioblock-node.json`

Host/system overview using standard `prometheus-node-exporter` metrics
(`node_cpu_seconds_total`, `node_memory_*`, `node_load*`, `node_network_*`,
`node_filesystem_*`, `node_boot_time_seconds`). These become available once a
node exporter is added to the compose topology and scraped — confirm the scrape
job exists before relying on them.

### `audioblock-indexer.json` (Issue #242)

Blockchain indexer health dashboard visualizing metrics from `IndexerService`:

- `indexer_lag_ledgers` — Ledgers behind latest Stellar ledger (by network/contract)
- `indexer_events_processed_total` — Total events processed (cumulative and rate)
- `indexer_errors_total` — Error count and rate (with alerting)
- Event processing throughput (events/s)
- Lag distribution (p50/p95/p99)
- Per-network processing rate
- 24-hour summaries (events, errors)

Includes warning and critical rules for sustained high lag (>1000 and >10000
ledgers) and a warning when all lag metrics disappear. Covers all 5 AudioBlock
contracts (Artist, Song, Album, Marketplace, Royalty). The indexer worker
exposes these gauges at `/metrics`; keep that port reachable only from the
private monitoring network.

## Adding a dashboard

1. Create (or copy) a `*.json` file under `monitoring/dashboards/`.
2. Keep it valid JSON and reference the `Prometheus` datasource.
3. Restart Grafana (`docker compose up -d grafana`) or wait for the 10s
   reload; the new dashboard appears in the dashboards list.
