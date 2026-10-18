# Environment Variables Reference

Complete reference of all environment variables used by the AudioBlocks Backend.

## Table of Contents

- [Database](#database)
- [Redis](#redis)
- [RabbitMQ](#rabbitmq)
- [Authentication](#authentication)
- [AWS S3](#aws-s3)
- [Pinata / IPFS](#pinata--ipfs)
- [Soroban (Stellar)](#soroban-stellar)
- [Indexer Worker](#indexer-worker)
- [Dynamic Labs (EVM)](#dynamic-labs-evm)
- [Twitter OAuth](#twitter-oauth)
- [Email](#email)
- [Rate Limiting](#rate-limiting)
- [Logging](#logging)
- [Malware Scanning](#malware-scanning)
- [Worker / Job Queue](#worker--job-queue)
- [Server](#server)
- [CORS](#cors)

---

## Database

| Variable                      | Required | Default  | Description                                     |
| ----------------------------- | -------- | -------- | ----------------------------------------------- |
| `POSTGRES_HOST`               | Yes      | —        | PostgreSQL host address                         |
| `POSTGRES_PORT`               | Yes      | —        | PostgreSQL port (typically `5432`)              |
| `POSTGRES_USER`               | Yes      | —        | PostgreSQL username                             |
| `POSTGRES_PASSWORD`           | Yes      | —        | PostgreSQL password                             |
| `POSTGRES_DATABASE`           | Yes      | —        | Database name                                   |
| `DB_POOL_MAX`                 | No       | `20`     | Maximum connections in the pool                 |
| `DB_POOL_MIN`                 | No       | `5`      | Minimum idle connections maintained             |
| `DB_CONNECTION_TIMEOUT_MS`    | No       | `30000`  | Timeout (ms) to acquire a connection            |
| `DB_IDLE_TIMEOUT_MS`          | No       | `300000` | Time (ms) before an idle connection is released |
| `DB_POOL_METRICS_INTERVAL_MS` | No       | `30000`  | Interval (ms) for pool metrics logging          |

**Sensitive:** `POSTGRES_PASSWORD` — never log or commit.

---

## Redis

| Variable         | Required | Default | Description         |
| ---------------- | -------- | ------- | ------------------- |
| `REDIS_HOST`     | No       | `redis` | Redis host address  |
| `REDIS_PORT`     | No       | `6379`  | Redis port          |
| `REDIS_USERNAME` | No       | —       | Redis auth username |
| `REDIS_PASSWORD` | No       | —       | Redis auth password |

**Sensitive:** `REDIS_PASSWORD` — never log or commit.

---

## RabbitMQ

| Variable        | Required | Default | Description                                                      |
| --------------- | -------- | ------- | ---------------------------------------------------------------- |
| `RABBITMQ_URL`  | Yes      | —       | Full AMQP connection URL (e.g. `amqp://user:pass@rabbitmq:5672`) |
| `RABBITMQ_USER` | No       | —       | RabbitMQ username (used by docker-compose)                       |
| `RABBITMQ_PASS` | No       | —       | RabbitMQ password (used by docker-compose)                       |

**Sensitive:** `RABBITMQ_URL`, `RABBITMQ_PASS` — never log or commit.

---

## Authentication

| Variable               | Required | Default                 | Description                                     |
| ---------------------- | -------- | ----------------------- | ----------------------------------------------- |
| `JWT_SECRET`           | Yes      | —                       | Secret key for signing JWT tokens               |
| `APP_URL`              | No       | `http://localhost:3000` | Frontend URL for email verification/reset links |
| `PRIVY_APP_ID`         | No       | —                       | Privy application ID                            |
| `PRIVY_APP_SECRET`     | No       | —                       | Privy application secret                        |
| `PRIVY_WEBHOOK_SECRET` | No       | —                       | Privy webhook signing secret (Issue #606)       |
| `LISTENER_KEY_SALT`    | Yes*     | —                       | Secret salt for HMAC-SHA256 anonymization of listener IPs (required in production; Issue #793) |

**Sensitive:** `JWT_SECRET`, `PRIVY_APP_SECRET`, `PRIVY_WEBHOOK_SECRET`, `LISTENER_KEY_SALT` — never log or commit.

---

## AWS S3

| Variable                | Required | Default | Description                            |
| ----------------------- | -------- | ------- | -------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | Yes      | —       | AWS IAM access key                     |
| `AWS_SECRET_ACCESS_KEY` | Yes      | —       | AWS IAM secret key                     |
| `AWS_REGION`            | Yes      | —       | AWS region (e.g. `us-east-1`)          |
| `AWS_BUCKET_NAME`       | Yes      | —       | S3 bucket name for audio/cover storage |

**Sensitive:** `AWS_SECRET_ACCESS_KEY` — never log or commit.

---

## Pinata / IPFS

| Variable         | Required | Default | Description                           |
| ---------------- | -------- | ------- | ------------------------------------- |
| `PINATA_JWT`     | Yes      | —       | Pinata JWT for IPFS pinning           |
| `PINATA_GATEWAY` | Yes      | —       | Pinata gateway URL for IPFS retrieval |

**Sensitive:** `PINATA_JWT` — never log or commit.

---

## Soroban (Stellar)

| Variable                                  | Required | Default                                          | Description                            |
| ----------------------------------------- | -------- | ------------------------------------------------ | -------------------------------------- |
| `SOROBAN_NETWORK`                         | No       | `testnet`                                        | Network to use: `testnet` or `mainnet` |
| `SOROBAN_TESTNET_RPC_URL`                 | No       | `https://soroban-testnet.stellar.org`            | Testnet RPC endpoint                   |
| `SOROBAN_TESTNET_NETWORK_PASSPHRASE`      | No       | `Test SDF Network ; September 2015`              | Testnet network passphrase             |
| `SOROBAN_TESTNET_NFT_CONTRACT_ID`         | Yes\*    | —                                                | NFT contract address (testnet)         |
| `SOROBAN_TESTNET_ARTIST_CONTRACT_ID`      | Yes\*    | —                                                | Artist contract address (testnet)      |
| `SOROBAN_TESTNET_CATALOG_CONTRACT_ID`     | Yes\*    | —                                                | Catalog contract address (testnet)     |
| `SOROBAN_TESTNET_ROYALTY_CONTRACT_ID`     | Yes\*    | —                                                | Royalty contract address (testnet)     |
| `SOROBAN_TESTNET_MARKETPLACE_CONTRACT_ID` | Yes\*    | —                                                | Marketplace contract address (testnet) |
| `SOROBAN_MAINNET_RPC_URL`                 | No       | `https://mainnet.sorobanrpc.com`                 | Mainnet RPC endpoint                   |
| `SOROBAN_MAINNET_NETWORK_PASSPHRASE`      | No       | `Public Global Stellar Network ; September 2015` | Mainnet network passphrase             |
| `SOROBAN_MAINNET_NFT_CONTRACT_ID`         | Yes\*    | —                                                | NFT contract address (mainnet)         |
| `SOROBAN_MAINNET_ARTIST_CONTRACT_ID`      | Yes\*    | —                                                | Artist contract address (mainnet)      |
| `SOROBAN_MAINNET_CATALOG_CONTRACT_ID`     | Yes\*    | —                                                | Catalog contract address (mainnet)     |
| `SOROBAN_MAINNET_ROYALTY_CONTRACT_ID`     | Yes\*    | —                                                | Royalty contract address (mainnet)     |
| `SOROBAN_MAINNET_MARKETPLACE_CONTRACT_ID` | Yes\*    | —                                                | Marketplace contract address (mainnet) |

_\* Required for the selected network. All five IDs must be set for the chosen `SOROBAN_NETWORK`._

**Note:** The backend never holds Stellar secret keys. Artists sign transactions client-side (e.g. Freighter wallet).

---

## Indexer Worker

| Variable                          | Required | Default | Description                                                         |
| --------------------------------- | -------- | ------- | ------------------------------------------------------------------- |
| `INDEXER_ENABLED`                 | No       | `false` | Kill switch for the standalone indexer worker; set `true`/`1` to start it, no deploy needed |
| `INDEXER_POLL_INTERVAL_MS`        | No       | `5000`  | Poll interval for the Soroban event indexer                         |
| `INDEXER_PAGE_SIZE`               | No       | `100`   | Max events fetched per `getEvents` page                             |
| `INDEXER_LAG_MONITOR_INTERVAL_MS` | No       | `60000` | Interval for computing/exporting indexer lag                        |
| `INDEXER_OVERLAP_WINDOW`          | No       | `10`    | Ledger overlap window back from head                                |
| `INDEXER_GAP_THRESHOLD`           | No       | `50`    | Ledger gap threshold that triggers a warning                        |
| `INDEXER_METRICS_PORT`            | No       | `9464`  | HTTP port used to expose the standalone worker's Prometheus metrics |

### Subgraph queries

| Variable                           | Required | Default | Description                                                                  |
| ---------------------------------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `GRAPH_SUBGRAPH_URL`               | No       | —       | Direct GraphQL URL for the deployed subgraph                                 |
| `GRAPH_SUBGRAPH_ENDPOINT_TEMPLATE` | No       | —       | Gateway URL template containing `{apiKey}`                                   |
| `GRAPH_SUBGRAPH_API_KEY`           | No       | —       | API key for the Graph gateway                                                |
| `SUBGRAPH_CACHE_TTL_MS`            | No       | `30000` | Redis cache lifetime for successful subgraph responses; `0` disables caching |

**Sensitive:** `GRAPH_SUBGRAPH_API_KEY` — never log or commit.

---

## Dynamic Labs (EVM)

| Variable                 | Required | Default | Description                             |
| ------------------------ | -------- | ------- | --------------------------------------- |
| `DYNAMIC_ENVIRONMENT_ID` | No       | —       | Dynamic Labs environment ID             |
| `DYNAMIC_AUTH_TOKEN`     | No       | —       | Dynamic Labs auth token                 |
| `LISK_SEPOLIA_RPC_URL`   | No       | —       | Lisk Sepolia RPC URL for EVM operations |

**Sensitive:** `DYNAMIC_AUTH_TOKEN` — never log or commit.

---

## Twitter OAuth

| Variable                   | Required | Default                                           | Description                                        |
| -------------------------- | -------- | ------------------------------------------------- | -------------------------------------------------- |
| `TWITTER_CLIENT_ID`        | No       | —                                                 | OAuth 2.0 PKCE client ID                           |
| `TWITTER_CLIENT_SECRET`    | No       | —                                                 | OAuth 2.0 PKCE client secret                       |
| `TWITTER_REDIRECT_URI`     | No       | `http://localhost:4000/api/auth/twitter/callback` | OAuth callback URL (must match Twitter app config) |
| `TWITTER_SUCCESS_REDIRECT` | Yes      | —                                                 | Frontend URL to redirect after successful OAuth    |

**Sensitive:** `TWITTER_CLIENT_SECRET` — never log or commit.

---

## Email

| Variable         | Required | Default                   | Description                             |
| ---------------- | -------- | ------------------------- | --------------------------------------- |
| `EMAIL_PROVIDER` | No       | `resend`                  | Email provider: `resend` or `sendgrid`  |
| `EMAIL_API_KEY`  | Yes      | —                         | API key for the selected email provider |
| `EMAIL_FROM`     | No       | `noreply@audioblocks.com` | Sender email address                    |

**Sensitive:** `EMAIL_API_KEY` — never log or commit.

---

## Rate Limiting

| Variable                     | Required | Default           | Description                                  |
| ---------------------------- | -------- | ----------------- | -------------------------------------------- |
| `AUTH_RATE_LIMIT_WINDOW_MS`  | No       | `900000` (15 min) | Time window for auth endpoint rate limiting  |
| `AUTH_RATE_LIMIT_MAX`        | No       | `20`              | Max requests per window for auth endpoints   |
| `NONCE_RATE_LIMIT_WINDOW_MS` | No       | `900000` (15 min) | Time window for nonce endpoint rate limiting |
| `NONCE_RATE_LIMIT_MAX`       | No       | `10`              | Max requests per window for nonce endpoint   |
| `AUTH_RATE_LIMIT_MEMORY_FALLBACK` | No  | `false`           | When Redis is down, enforce per-instance in-memory limits on auth, nonce and password-reset endpoints instead of returning `503` (see [RATE_LIMITING.md](./RATE_LIMITING.md#redis-unavailable)) |

---

## Logging

| Variable    | Required | Default | Description                                      |
| ----------- | -------- | ------- | ------------------------------------------------ |
| `LOG_LEVEL` | No       | `info`  | Pino log level: `debug`, `info`, `warn`, `error` |

---

## Malware Scanning

| Variable            | Required | Default                   | Description                                                |
| ------------------- | -------- | ------------------------- | ---------------------------------------------------------- |
| `SCAN_PROVIDER`     | No       | `clamav`                  | Scanner backend: `clamav` (prod) or `skip` (dev/test only) |
| `CLAMAV_URL`        | No       | `http://clamav:9000/scan` | ClamAV REST sidecar endpoint                               |
| `CLAMAV_TIMEOUT_MS` | No       | `30000`                   | Scan request timeout (ms)                                  |

**Warning:** Never use `SCAN_PROVIDER=skip` in production.

---

## Worker / Job Queue

| Variable                   | Required | Default | Description                                         |
| -------------------------- | -------- | ------- | --------------------------------------------------- |
| `WORKER_MAX_ATTEMPTS`      | No       | `3`     | Max processing attempts before DLQ (song processor) |
| `WORKER_BACKOFF_BASE_MS`   | No       | `2000`  | Base delay (ms) for exponential backoff             |
| `WORKER_BACKOFF_MAX_MS`    | No       | `30000` | Maximum backoff delay (ms)                          |
| `JOB_MAX_ATTEMPTS`         | No       | `3`     | Default max attempts per background job             |
| `JOB_BACKOFF_BASE_MS`      | No       | `2000`  | Base backoff delay for job retries                  |
| `JOB_BACKOFF_MAX_MS`       | No       | `30000` | Maximum backoff for job retries                     |
| `JOB_COMPLETED_TTL_S`      | No       | `3600`  | How long (seconds) to retain completed jobs         |
| `JOB_QUEUE_WARN_THRESHOLD` | No       | `100`   | Warn when queued jobs exceed this count             |
| `JOB_MONITOR_INTERVAL_MS`  | No       | `30000` | Interval (ms) for queue depth metrics logging       |
| `HLS_AUDIO_BITRATE`        | No       | `256k`  | Target AAC bitrate for HLS transcoding (e.g. `128k`, `256k`) |

---

## Server

| Variable   | Required | Default       | Description                                     |
| ---------- | -------- | ------------- | ----------------------------------------------- |
| `PORT`     | No       | `4000`        | HTTP server listen port                         |
| `NODE_ENV` | No       | `development` | Environment mode: `development` or `production` |

---

## CORS

| Variable          | Required | Default           | Description                                  |
| ----------------- | -------- | ----------------- | -------------------------------------------- |
| `ALLOWED_ORIGINS` | No       | localhost origins | Comma-separated list of allowed CORS origins |

**Example:**

```
ALLOWED_ORIGINS=https://listener.audioblockz.com,https://artist.audioblockz.com
```

---

## Startup Validation

At startup, the server validates that all required environment variables are
present before connecting to the database or starting the HTTP listener. If
any required variables are missing, the server logs a clear error message and
exits immediately with code 1.

The validation is performed in `src/config/env.ts` and called at the top of
`main()` in `src/index.ts`.
