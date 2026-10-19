# Structured Logging & Centralized Log Aggregation (Issue #380)

## Overview

AudioBlock Backend implements structured JSON logging using [Pino](https://getpino.io). All logs carry service metadata (`audioblock-backend`), runtime environment, ISO timestamps, request correlation IDs (`reqId`), and HTTP context.

Centralized log aggregation is wired to **Grafana Loki** via a **Promtail sidecar** in Docker Compose and Kubernetes environments, and also supports **direct HTTP log shipping** via the `LOG_AGGREGATOR_URL` environment variable.

---

## 1. Zero Sensitive Data Leakage (Redaction)

To strictly enforce that **no credentials, tokens, or sensitive user data are shipped or persisted in logs**, Pino's native `redact` engine automatically sanitizes all matching fields before logs are emitted or shipped:

- Passwords (`password`, `newPassword`, `oldPassword`, `confirmPassword`)
- Authentication tokens & headers (`token`, `accessToken`, `refreshToken`, `authorization`, `headers.authorization`)
- Secrets & keys (`apiKey`, `secret`, `jwtSecret`, `clientSecret`, `privateKey`, `twoFactorSecret`, `totpSecret`)
- Financial & PII attributes (`creditCard`, `cardNumber`, `cvv`, `ssn`)

All matching values are replaced with `[REDACTED]`.

---

## 2. Log Aggregation Topology

### Local / Staging Docker Stack

In `docker-compose.yml`, the observability stack provides:

```
┌─────────────────────────┐
│   audioblocks-backend   │
│ (stdout structured JSON)│
└────────────┬────────────┘
             │ Docker socket stream
             ▼
┌─────────────────────────┐
│        Promtail         │
│  (parses JSON & labels) │
└────────────┬────────────┘
             │ HTTP POST /loki/api/v1/push
             ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│       Grafana Loki      │◄────────┤         Grafana         │
│ (centralized retention) │         │ (interactive log search)│
└─────────────────────────┘         └─────────────────────────┘
```

1. **Backend** emits single-line JSON logs to `stdout`.
2. **Promtail** sidecar automatically ingests container stdout via the Docker daemon socket (`unix:///var/run/docker.sock`), applies JSON parsing, and extracts labels (`service`, `level`, `statusCode`).
3. **Loki** indexes labels and stores compressed log chunks on the `loki_data` volume.
4. **Grafana** provisions Loki as a default log datasource (`http://loki:3100`), allowing developers to search, filter, and correlate logs against Prometheus metrics in Grafana Explore.

---

## 3. How to Run Locally

Start the minimal backend stack with the monitoring & logging profile:

```bash
docker compose --profile monitoring up -d
# or full stack
docker compose --profile full up -d
```

Services started:
- Backend: `http://localhost:4000`
- Prometheus: `http://localhost:9090`
- Grafana Loki: `http://localhost:3100`
- Promtail: `http://localhost:9080`
- Grafana: `http://localhost:3000` (Login: `admin` / `admin`)

---

## 4. Querying Logs in Grafana

1. Open Grafana in your browser: `http://localhost:3000`.
2. Navigate to **Explore** (compass icon on the left menu).
3. Select datasource: **Loki**.
4. Run LogQL queries:

```logql
# Stream all logs from AudioBlock backend
{container_name="audioblocks-backend"}

# Filter by log level
{container_name="audioblocks-backend"} | json | level="error"

# Search for specific request correlation ID
{container_name="audioblocks-backend"} |= "reqId" | json | reqId="<uuid>"

# Search for 5xx errors
{container_name="audioblocks-backend"} | json | statusCode >= 500
```

---

## 5. Direct HTTP Log Shipping (Non-Docker / Serverless)

If running outside Docker (e.g. bare metal or serverless) without a sidecar, direct log shipping can be enabled by setting:

```bash
LOG_AGGREGATOR_URL=http://loki:3100/loki/api/v1/push
```

When `LOG_AGGREGATOR_URL` is set:
- Logs continue writing to `stdout` for local visibility.
- `logger` batches and asynchronously flushes log records in batches of up to 50 entries or every 2 seconds via `POST`.
- Aggregator outages fail open to prevent application degradation.
