# AudioBlocks Backend

The shared API and processing pipeline behind **AudioBlocks**, a music NFT
platform on Stellar/Soroban. It handles user authentication, song/album
upload and transcoding, IPFS metadata pinning, and acts as a **non-custodial
relay** for on-chain actions — it builds and submits Soroban transactions on
an artist's behalf without ever holding their private key.

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Model](#data-model)
- [API Reference](#api-reference)
- [The Song Processing Pipeline](#the-song-processing-pipeline)
- [On-Chain Integration: Client Signs, Backend Relays](#on-chain-integration-client-signs-backend-relays)
- [Authentication](#authentication)
- [Environment Variables](#environment-variables)
- [Documentation](#documentation)
- [Getting Started](#getting-started)
- [Scripts](#scripts)
- [Known Issues / Cleanup Backlog](#known-issues--cleanup-backlog)

## Architecture

```
                 ┌──────────────┐        ┌──────────────┐
 Artist/Listener │   Frontend    │◀──────▶│   Express API │
      Apps       │ (Next.js)     │  REST  │  (this repo)  │
                 └──────────────┘        └──────┬───────┘
                                                  │
                ┌─────────────────┬──────────────┼───────────────┬──────────────┐
                ▼                 ▼              ▼               ▼              ▼
           PostgreSQL          Redis        RabbitMQ          S3            Stellar/Soroban
         (TypeORM models)   (nonces,      (song_processing  (audio/cover    RPC (transaction
                              manifest      queue)            storage)       relay only —
                              cache)                                         no keys held)
                                              │
                                              ▼
                                     Song Processor Worker
                                  (ffmpeg transcode → HLS,
                                   Pinata/IPFS metadata pin)
```

The HTTP server starts immediately on boot (so deploy-platform health checks
pass) and connects to RabbitMQ — and starts the background worker — only
after the server is already listening; if RabbitMQ is briefly unavailable,
the API still serves requests, just without background song processing.

## Tech Stack

| Concern                    | Library                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Runtime / language         | Node.js 20, TypeScript 5                                                                |
| Web framework              | Express 5                                                                               |
| ORM / database             | TypeORM 0.3 + PostgreSQL (`pg`)                                                         |
| Validation                 | `class-validator` + `class-transformer` (DTO pattern)                                   |
| Auth                       | `jsonwebtoken`, `bcrypt` (email/password), `ethers` (EVM wallet-signature verification) |
| File upload                | `multer` (chunked audio upload, profile images, cover art)                              |
| Media processing           | `fluent-ffmpeg` (HLS transcoding; requires the system `ffmpeg` binary)                  |
| Object storage             | AWS S3 (`@aws-sdk/client-s3`)                                                           |
| Decentralized storage      | Pinata (IPFS pinning for NFT metadata)                                                  |
| Queueing                   | RabbitMQ (`amqplib`) — async song-processing jobs                                       |
| Caching                    | Redis (`ioredis`) — login nonces, signed-manifest cache, OAuth state                    |
| On-chain (Stellar/Soroban) | `@stellar/stellar-sdk` — transaction building, simulation, and relay                    |
| On-chain (EVM, legacy)     | `ethers`, Dynamic Labs MPC wallet service                                               |

## Project Structure

```
src/
├── index.ts              # entry point: bootstraps DB, server, RabbitMQ, worker
├── app.ts                # Express app: middleware, route mounting, error handlers
├── config/                # db, redis, rabbitmq, s3, soroban, dynamic (EVM) clients
├── controllers/           # one per resource: Auth, ArtistProfile, ArtistOnChain,
│                           #   Song, Upload, User, Wallet
├── dtos/                  # class-validator request shapes
├── entities/               # TypeORM models: User, Song, Album, Genre, TransactionLog
├── middlewares/             # authArtistMiddleware / authListenerMiddleware, validateDTO
├── routes/                 # Express routers, one per resource
├── services/                # business logic, including:
│   ├── Artist/ArtistService.ts        # artist profile + on-chain setup
│   ├── Soroban/SorobanService.ts       # generic prepare/submit relay
│   ├── SongService.ts                  # upload pipeline + on-chain minting
│   ├── AuthService.ts                  # wallet-signature + email/password auth
│   └── UserService.ts
├── workers/                # SongProcessorWorker (active), precomputeManifest
├── seeders/                 # genre seeder, run on every boot
└── utils/, validators/, interfaces/
```

## Data Model

| Entity             | Purpose                                   | Notable fields                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**           | Account record, supports two auth methods | `walletAddress?` (wallet auth), `passwordHash?` (email/password auth), `stellarPublicKey?` / `stellarArtistId?` / `stellarArtistTokenId?` (Soroban identity once an artist connects a wallet and registers on-chain), `role` (`listener` \| `artist` \| `admin`)                                                |
| **Song**           | One row per uploaded track                | `status` (`processing` \| `ready` \| `failed`) gates streaming; **`mintStatus`** (`not_minted` \| `pending` \| `minted` \| `failed`) is tracked independently — minting is a separate, artist-initiated action, decoupled from whether the song is streamable; `metadataCid`, `onChainSongId`, `onChainTokenId` |
| **Album**          | One row per published album               | `songs: string[]` (song UUIDs)                                                                                                                                                                                                                                                                                  |
| **Genre**          | Lookup table, seeded on boot              | —                                                                                                                                                                                                                                                                                                               |
| **TransactionLog** | Audit trail of significant actions        | `action` (e.g. `CREATE_USER`, `SONG_PROCESSED`), `txHash`                                                                                                                                                                                                                                                       |

## API Reference

All protected routes require `Authorization: Bearer <jwt>` and the
appropriate role (`authArtistMiddleware` for artist-only routes).

### Auth — `/api/auth`

| Method | Path                 | Auth                                     | Description                                                                                    |
| ------ | -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/nonce/:email`      | —                                        | Generates a login nonce (5 min TTL in Redis) for wallet-signature auth                         |
| POST   | `/register`          | —                                        | Wallet-signature signup (`role`, `walletAddress`, `signature`, `message`, `email`, `username`) |
| POST   | `/register-listener` | —                                        | Same as above, listener-oriented, no `username` required                                       |
| POST   | `/login`             | —                                        | Wallet-signature login                                                                         |
| POST   | `/register-email`    | —                                        | Email + password signup                                                                        |
| POST   | `/login-email`       | —                                        | Email + password login                                                                         |
| POST   | `/2fa/enable`        | any authenticated email/password account | Enables TOTP 2FA and returns QR/secret plus backup codes                                       |

### Artist — `/api/artist`

| Method | Path                      | Auth   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/:id/metadata`           | —      | **Public artist metadata** — returns `{ openGraph: { title, description, image, url, type }, jsonLd: { "@context","@type","name",... }, profile: { id, username, name, bio, profileImage, pageCover, website, twitterUsername } }` for OG tags / link previews and search indexing. No private fields (email, walletAddress, stellarPublicKey) are ever exposed. Append `?format=html` for an HTML fragment with `<meta property="og:*">` + `<script type="application/ld+json">`. |
| PATCH  | `/update-profile`         | artist | Updates bio/website/etc., accepts `profileImage`/`pageCover` uploads                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/onchain/connect-wallet` | artist | Records the artist's Stellar public key                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/onchain/prepare-setup`  | artist | Builds an unsigned `setup_artist_profile` Soroban transaction                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/onchain/submit-setup`   | artist | Submits the wallet-signed transaction, persists the resulting artist/token IDs                                                                                                                                                                                                                                                                                                                                                                                                     |

### Song — `/api/song`

| Method | Path                        | Auth   | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/upload/chunk`             | artist | Uploads one chunk of a large audio file                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/upload/cover`             | artist | Uploads cover art, pushes to S3                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/upload/finalize`          | artist | Merges chunks, creates the `Song` row, queues background processing                                                                                                                                                                                                                                                                                                                      |
| GET    | `/stream/:id`               | —      | Returns the song's HLS manifest (presigned S3 URLs), cached in Redis                                                                                                                                                                                                                                                                                                                     |
| GET    | `/embed/:id`                | —      | **Embeddable player** — returns `{ title, coverArtPath, artist: { name, username, profileImage }, streamUrl, hlsMasterUrl, duration }` for public/ready songs without auth; rate-limited via Redis (`30s` per IP per song, same bucket as streaming). Use as `GET /api/song/embed/:id` or `GET /api/embed/song/:id`. For playlists: `GET /api/embed/album/:id`. No private data exposed. |
| POST   | `/:id/onchain/prepare-mint` | artist | Builds an unsigned `upload_and_mint_song` Soroban transaction                                                                                                                                                                                                                                                                                                                            |
| POST   | `/:id/onchain/submit-mint`  | artist | Submits the wallet-signed mint transaction (triggers `song.minted` webhook)                                                                                                                                                                                                                                                                                                              |

### Wallet — `/api/wallet` (EVM, Dynamic Labs)

| Method | Path               | Auth | Description                                       |
| ------ | ------------------ | ---- | ------------------------------------------------- |
| POST   | `/evm/create`      | —    | Creates an MPC-backed EVM wallet via Dynamic Labs |
| POST   | `/evm/signMessage` | —    | Signs a message with a Dynamic-managed wallet     |

### Webhooks — `/api/webhooks`

| Method | Path        | Auth              | Description                                                                                                                                                                                                                                                                     |
| ------ | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/register` | any authenticated | Registers a webhook subscription: `{ endpoint: "https://example.com/hook", eventTypes: ["song.minted","sale.completed"], secret?: "optional-hmac-secret" }`. Returns the created subscription with `id` + generated `secret` (store it — used to verify `X-Webhook-Signature`). |
| GET    | `/`         | any authenticated | Lists your webhook subscriptions                                                                                                                                                                                                                                                |
| DELETE | `/:id`      | any authenticated | Deletes your webhook subscription                                                                                                                                                                                                                                               |
| POST   | `/:id/test` | any authenticated | Sends a test `test.event` payload to verify the endpoint                                                                                                                                                                                                                        |

Events: `song.minted` (also `mint_status_changed` legacy), `sale.completed` (also `sale_completed`). Each delivery sends `POST` with `Content-Type: application/json`, `X-Webhook-Signature: <hmac-sha256 hex of JSON body>`, body `{ eventId, eventType, timestamp, ...eventData }`. Failed deliveries retry **3× with exponential backoff** (`1s, 2s, 4s`) before being dead-lettered. Hook is emitted in `SongService.submitSongMintTx` (after mint) and `MarketplaceService.submitBuy` (after sale).

Signature verification (recipient):

```js
const sig = req.headers['x-webhook-signature'];
const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)))
  throw new Error('invalid signature');
```

### Takedown — `/api/takedown` (copyright workflow)

| Method | Path          | Auth              | Description                                                                                                            |
| ------ | ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/request`    | any authenticated | Creates a **dedicated `TakedownRequest`** (distinct from generic `ContentReport`/flag): `{ songId, reason: "copyright" | "trademark" | "other", description?, evidenceUrl? }`. Status `pending`.                                                                                                                                                                                                               |
| GET    | `/`           | admin             | Lists takedown requests (filter `?status=pending&songId=...`)                                                          |
| GET    | `/:id`        | admin             | Gets single takedown request                                                                                           |
| PATCH  | `/:id/review` | admin             | Reviews takedown: `{ action: "approve"                                                                                 | "reject"    | "reverse", reviewNotes? }`. `approve` temporarily unpublishes the song (`song.flagged=true`, `flagReason=takedown:...`, streaming returns 404) — **reversible**; `reverse`republishes if the claim is resolved in the artist's favor (restores`previousFlagged` state). |

This workflow is **separate from general moderation** (`PATCH /api/admin/song/:id/flag`) and uses its own `takedown_requests` table, supporting audit and reversibility.

### Embed — `/api/embed`

| Method | Path         | Auth | Description                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/song/:id`  | —    | Lightweight embed data for third-party sites: `{ title, coverArtPath, artist:{name,username,profileImage}, streamUrl, hlsMasterUrl, duration, genre }`. Works for `status="ready"` and not-flagged songs **without authentication**, CORS-open, Redis-throttled `30s` per IP per song (same limit as `GET /api/song/stream/:id`). Also available as `GET /api/song/embed/:id`. |
| GET    | `/album/:id` | —    | Playlist embed: `{ title, coverArtPath, artist, songs: [SongEmbedData] }` — skips unavailable songs. Same rate limiting.                                                                                                                                                                                                                                                       |

Example embed usage:

```html
<iframe src="https://api.audioblock.com/api/embed/song/<songId>" width="320" height="120"></iframe>
<script>
  fetch('https://api.audioblock.com/api/song/embed/<songId>')
    .then((r) => r.json())
    .then(({ data }) => {
      // data.streamUrl -> fetch HLS manifest, data.coverArtPath -> <img>, data.artist.name
    });
</script>
```

### Twitter OAuth — `/api/auth/twitter`

| Method | Path        | Auth   | Description                                                            |
| ------ | ----------- | ------ | ---------------------------------------------------------------------- |
| GET    | `/init`     | artist | Starts the OAuth2 PKCE flow, redirects to Twitter                      |
| GET    | `/callback` | —      | Twitter's redirect target; links the account to the authenticated user |

## The Song Processing Pipeline

Upload and minting are deliberately decoupled: a song becomes **streamable**
as soon as background processing finishes, with **minting left as a
separate step the artist triggers afterward** by signing a transaction.

1. **Chunked upload** (`POST /song/upload/chunk` × N) — the client splits
   the audio file client-side and uploads it in pieces.
2. **Finalize** (`POST /song/upload/finalize`) — the backend merges the
   chunks into one file, uploads it to S3, creates the `Song` row
   (`status: "processing"`), and enqueues a job on the `song_processing`
   RabbitMQ queue.
3. **Background worker** (`SongProcessorWorker`, consuming that queue):
   - Transcodes the merged audio to **HLS** via `ffmpeg`.
   - Uploads every HLS segment + the master playlist to S3.
   - Pins the cover art and a generated NFT-style metadata JSON
     (name, artist, description, `animation_url`, attributes) to **IPFS**
     via Pinata.
   - Updates the `Song` row: `status: "ready"`, `hlsMasterUrl`,
     `metadataCid`.
   - Pre-warms the signed-manifest cache and writes a `TransactionLog`
     entry.
4. **Streaming** (`GET /song/stream/:id`) — serves a presigned-URL HLS
   manifest, cached in Redis for a few minutes at a time, regenerated on
   cache miss.
5. **Minting** (separate, artist-initiated, any time after step 3
   finishes) — see below.

## On-Chain Integration: Client Signs, Backend Relays

The backend **never holds an artist's Stellar secret key**. Every on-chain
write follows the same three-step relay pattern, implemented once in
`SorobanService` and reused for both artist setup and song minting:

1. **Prepare** (`prepareInvocation`) — given the artist's _public_ key, the
   target contract, and the method/args, the backend fetches the artist's
   on-chain account, builds the contract-call operation, and asks Soroban
   to simulate/assemble the transaction. Returns the **unsigned transaction
   as XDR**.
2. **Sign** (client-side, not in this repo) — the artist's wallet (e.g.
   Freighter) signs the XDR. The artist's address is both the fee-paying
   source account and the address being authorized, so a single client-side
   signature is sufficient.
3. **Submit** (`submitSignedTransaction`) — the backend takes the
   wallet-signed XDR the client sends back, submits it to the Soroban RPC,
   polls until it's confirmed, and decodes the contract's return value.

This pattern powers two flows:

- **Artist on-chain setup**: `connect-wallet` (store the public key) →
  `prepare-setup` (build `setup_artist_profile`) → sign in wallet →
  `submit-setup` (persist the resulting `artist_id`/`token_id`).
- **Song minting**: `prepare-mint` (build `upload_and_mint_song`, requires
  `metadataCid` to already exist) → sign in wallet → `submit-mint` (persist
  `onChainSongId`/`onChainTokenId`, set `mintStatus: "minted"`).

See the [`AudioB_Contract_Soroban`](../AudioB_Contract_Soroban) repo for the
contracts themselves.

## Authentication

Three parallel signup/login flows converge on an identical JWT payload, so
downstream code never needs to know which method a user used:

**Wallet-signature (EVM)** — `ethers.verifyMessage` cryptographically
recovers the signing address from a user-provided signature and checks it
matches the claimed wallet address; a nonce embedded in the signed message
(stored in Redis, single-use) prevents replay.

**Email + password** — standard bcrypt-hashed password (12 salt rounds),
compared on login. Email/password accounts can enroll TOTP 2FA via
`POST /api/auth/2fa/enable` with an existing JWT. Enrollment returns the
shared secret, an otpauth URL/QR data URL, and backup recovery codes. Once
enabled, `POST /api/auth/login-email` requires either `twoFactorCode` or
`recoveryCode` in addition to the email/password.

**Privy** — delegated authentication using [Privy](https://privy.io). Privy
provides wallet-less authentication, embedded wallets, and social login. The
backend verifies Privy-issued ES256 JWT access tokens using cached public
keys (JWKS). See [Privy Integration Setup](#privy-integration-setup) below.

All three methods issue a JWT (`expiresIn: "1d"`) carrying `id`, `email`, `role`,
`walletAddress`, and profile fields. `authArtistMiddleware` /
`authListenerMiddleware` verify the token and enforce the required role on
protected routes.

### Privy Integration Setup

Privy authentication is **optional** and controlled by the `AUTH_MODE` feature
flag. The backend can operate in three modes:

| `AUTH_MODE` | Legacy Auth | Privy Auth | Use Case                    |
| ----------- | ----------- | ---------- | --------------------------- |
| `legacy`    | ✓           | ✗          | Default / pre-migration     |
| `both`      | ✓           | ✓          | Staged rollout              |
| `privy`     | ✗           | ✓          | Post-migration (Privy only) |

#### Required Environment Variables

```bash
# Privy Authentication (optional, all three required if any is set)
PRIVY_APP_ID=your_app_id                    # From Privy dashboard
PRIVY_APP_SECRET=your_app_secret            # For privileged API calls
AUTH_MODE=both                              # 'legacy' | 'both' | 'privy'
```

If Privy is not needed, leave all Privy variables unset. The application will
log a warning and operate in `legacy` mode.

#### Setup Steps

1. **Create a Privy app** at [https://dashboard.privy.io](https://dashboard.privy.io)
2. **Copy credentials** from the Privy dashboard:
   - App ID (Configuration → App settings)
   - App Secret (Configuration → App settings → API Keys)
3. **Set environment variables** in `.env` or your deployment platform:
   ```bash
   PRIVY_APP_ID=your_app_id_from_dashboard
   PRIVY_APP_SECRET=your_secret_from_dashboard
   AUTH_MODE=both  # Start with 'both' for gradual rollout
   ```
4. **Configure CORS** — ensure your frontend domain is in `ALLOWED_ORIGINS`
5. **Test the integration**:

   ```bash
   # Health check (should show Privy enabled)
   curl http://localhost:4000/api/health

   # Login with Privy (requires Privy ID token from client)
   curl -X POST http://localhost:4000/api/auth/privy/login \
     -H "Content-Type: application/json" \
     -d '{"idToken": "privy_id_token_here"}'
   ```

#### Optional: Tuning Resilience Parameters

The Privy integration includes circuit breaking, retry logic, and key caching
to survive transient Privy outages. These can be tuned via environment variables:

```bash
# JWKS caching (Issue #634)
PRIVY_JWKS_TTL_MS=3600000                   # 1 hour (default)
PRIVY_JWKS_STALE_TTL_MS=86400000            # 24 hours (default)
PRIVY_JWKS_NEGATIVE_TTL_MS=60000            # 1 minute (default)

# Retry and circuit breaking (Issue #635)
PRIVY_RETRY_ATTEMPTS=3                      # Total attempts (default)
PRIVY_RETRY_BASE_DELAY_MS=200               # First backoff delay (default)
PRIVY_RETRY_MAX_DELAY_MS=2000               # Max backoff delay (default)
PRIVY_CIRCUIT_FAILURE_THRESHOLD=5           # Consecutive failures before open (default)
PRIVY_CIRCUIT_RESET_TIMEOUT_MS=30000        # 30 seconds (default)
PRIVY_ALLOW_STALE_KEYS=true                 # Serve stale keys on error (default)

# Legacy fallback during outages
PRIVY_ALLOW_LEGACY_FALLBACK=true            # Keep legacy auth alive during outages (default)
```

#### Monitoring

Privy integration exposes Prometheus metrics for observability:

- `privy_token_verifications_total{outcome}` — Token verification attempts
- `privy_jwk_cache_hits_total` — JWKS cache performance
- `privy_circuit_state{state}` — Circuit breaker state
- `auth_failures_total{auth_method,failure_type}` — Authentication failures

Alert rules are defined in `monitoring/prometheus-alerts.yml`.

#### Session Revocation

When a user logs out or sessions are revoked:

- **Privy-side**: Sessions are revoked via Privy's API (`POST /v1/users/{id}/sessions/revoke`)
- **Local tracking**: Revoked sessions are tracked in-process for early rejection
- **Token rejection**: Revoked session tokens return `401 SESSION_REVOKED`

Endpoint: `POST /api/auth/mfa/sessions/revoke` (requires valid Privy token)

#### Admin Access to Linked Accounts

Admins can view Privy-linked accounts for any user:

```bash
GET /api/admin/users/:id/linked-accounts
```

Returns all linked authentication methods (wallets, emails, social providers),
MFA status, and account creation date.

#### Further Reading

- [Privy Authentication Guide](docs/PRIVY_AUTH.md) — Resilience & rollout details
- [Privy Implementation Guide](docs/PRIVY_AUTH_IMPLEMENTATION.md) — Full API reference
- [Privy Migration Guide](docs/PRIVY_MIGRATION_GUIDE.md) — Migrating existing accounts
- [Privy Security Checklist](docs/PRIVY_AUTH_SECURITY_CHECKLIST.md)

## Environment Variables

```bash
# Server
PORT=4000
NODE_ENV=development

# PostgreSQL
POSTGRES_HOST=
POSTGRES_PORT=
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DATABASE=

# Redis
REDIS_HOST=
REDIS_PORT=6379
REDIS_USERNAME=
REDIS_PASSWORD=

# RabbitMQ
RABBITMQ_URL=          # required by the background worker queue connection

# Auth
JWT_SECRET=            # required

# AWS S3
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_BUCKET_NAME=

# Pinata / IPFS
PINATA_JWT=
PINATA_GATEWAY=

# Soroban (Stellar)
SOROBAN_NETWORK=testnet
SOROBAN_TESTNET_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_TESTNET_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SOROBAN_TESTNET_NFT_CONTRACT_ID=
SOROBAN_TESTNET_ARTIST_CONTRACT_ID=
SOROBAN_TESTNET_CATALOG_CONTRACT_ID=
SOROBAN_TESTNET_ROYALTY_CONTRACT_ID=
SOROBAN_TESTNET_MARKETPLACE_CONTRACT_ID=
SOROBAN_MAINNET_RPC_URL=https://mainnet.sorobanrpc.com
SOROBAN_MAINNET_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
SOROBAN_MAINNET_NFT_CONTRACT_ID=
SOROBAN_MAINNET_ARTIST_CONTRACT_ID=
SOROBAN_MAINNET_CATALOG_CONTRACT_ID=
SOROBAN_MAINNET_ROYALTY_CONTRACT_ID=
SOROBAN_MAINNET_MARKETPLACE_CONTRACT_ID=

# Dynamic Labs (legacy EVM wallet service)
DYNAMIC_ENVIRONMENT_ID=
DYNAMIC_AUTH_TOKEN=
LISK_SEPOLIA_RPC_URL=

# Twitter OAuth2 (PKCE)
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=
TWITTER_REDIRECT_URI=
TWITTER_SUCCESS_REDIRECT=

# Worker / streaming tuning (optional, sensible defaults exist)
MANIFEST_CACHE_TTL=300
SIGNED_URL_EXPIRES=300
```

> The backend deliberately has **no** environment variable for an artist's
> or platform's Stellar secret key — on-chain writes are always relayed,
> never signed server-side.

### Updating Soroban Contract Addresses

`src/config/soroban.ts` treats the five AudioBlocks Soroban contract IDs as
a versioned per-network config surface. Set `SOROBAN_NETWORK` to `testnet`
or `mainnet`; startup validates that all five IDs for that selected network
are present before the API connects to the database.

When the `AudioB_Contract_Soroban` team redeploys, copy the deployment
output for the matching network into the five env vars with the same network
prefix:

```bash
SOROBAN_TESTNET_NFT_CONTRACT_ID=
SOROBAN_TESTNET_ARTIST_CONTRACT_ID=
SOROBAN_TESTNET_CATALOG_CONTRACT_ID=
SOROBAN_TESTNET_ROYALTY_CONTRACT_ID=
SOROBAN_TESTNET_MARKETPLACE_CONTRACT_ID=
```

For mainnet, use the same names with `SOROBAN_MAINNET_`. Commit updates to
deployment secret stores or environment dashboards together with the contract
repo deployment tag/commit in the release notes so backend and contract
versions can be traced together.

## Operations runbooks

- [Disaster recovery: DB, S3, Redis, RabbitMQ and region loss](docs/runbooks/disaster-recovery.md)
- [Staging and production parity audit and checklist](docs/staging-production-parity.md)
- [Worker horizontal scaling, prefetch and multi-instance verification](docs/worker-scaling.md)

## S3 Storage and Lifecycle Management

Audio uploads are stored in AWS S3, with a structured prefix strategy to
separate raw uploads, transcoded HLS segments, and cover art.

### Bucket Structure

```
s3://my-bucket/
  uploads/
    raw/           # Raw merged audio files (uploaded by artist)
      {songId}.mp3
    hls/           # Transcoded HLS segments (generated by background worker)
      {songId}/
        master.m3u8
        segment-0.ts
        segment-1.ts
        ...
    covers/        # Cover art and profile images
      {userId}/profile.png
      {songId}/cover.jpg
```

### Lifecycle Policy

To minimize storage costs, define an S3 lifecycle rule that:

1. **Transitions or deletes raw uploads** after successful transcoding.
   - Raw files are only needed during active transcoding; once HLS segments
     exist, the raw file is redundant.
   - Option A: Delete after 7 days (assumes transcoding completes within hours).
   - Option B: Transition to Glacier for long-term cold storage.

2. **Preserves HLS segments and cover art indefinitely** (they serve live
   streams and metadata).

Example lifecycle configuration (AWS console or Terraform):

```json
{
  "Rules": [
    {
      "Id": "DeleteRawAudioAfterTranscode",
      "Filter": { "Prefix": "uploads/raw/" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    }
  ]
}
```

Alternatively, delete the raw file explicitly in the background worker
(`src/workers/SongProcessorWorker.ts`) immediately after HLS transcoding
completes and is uploaded:

```typescript
await s3
  .deleteObject({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `uploads/raw/${song.id}.mp3`,
  })
  .promise();
```

This is more precise (no 7-day lag) and easier to test locally.

## Environment Variable Validation

At startup, the server validates that all required environment variables are
present before connecting to the database or starting the HTTP listener. If
any critical variables are missing, the server logs a clear, itemized error
message and exits immediately (process exit code 1). This is faster and more
transparent than discovering missing config later during API calls.

The validation is performed in `src/config/env.ts` and called at the top of
`main()` in `src/index.ts`, before any other initialization.

## Secrets Management

**Development:** Secrets are stored locally in `.env` (never committed). Copy
`.env.example` to `.env` and fill in real values.

**Production:** The recommended approach depends on your deployment platform:

- **Render/Heroku/Railway:** Use the platform's native environment variable
  dashboard. Secrets are injected at container startup as process env vars and
  reach the running application the same way as in development.
- **AWS:** Use [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
  or [AWS Systems Manager Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html).
  Fetch secrets at container startup and populate env vars, or integrate the
  secrets into your CI/CD pipeline and inject them into the ECS/Lambda task
  definition.
- **Kubernetes:** Use [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
  and mount them as env vars or files.
- **Docker:** Inject secrets at `docker run` time using `--env-file` or `--env`
  flags. Never bake secrets into the image.

In all cases, ensure that:

- `.env` is in `.gitignore` (it is).
- No real secrets exist in git history or public container registries.
- The startup validation catches any missing secrets before the server listens.

## Database Migrations

Schema changes in production are managed with TypeORM migrations, not
`synchronize: true`, which is unsafe once real user data exists.

### Local Development

In development, `synchronize: true` automatically creates or alters tables to
match your entity definitions, allowing rapid iteration. Migrations are not
required for local work.

### Production

In production, `NODE_ENV=production` disables auto-synchronize. Schema changes
are applied explicitly via migrations:

1. **Generate a new migration** after editing entities:

   ```bash
   npm run migration:generate -- -n DescribeYourChange
   # This creates a new file in src/migrations/ capturing the detected
   # differences between the current schema and your entities.
   ```

2. **Review** the generated migration file in `src/migrations/`. Adjust if
   needed (e.g., if the tool misses a constraint or index).

3. **Test** in a staging database:

   ```bash
   NODE_ENV=production npm run build
   npm run migration:run
   ```

4. **Deploy** (the app will run migrations automatically on startup if
   `migrations` are configured in `src/config/db.ts`, or you can run them
   manually before starting the server).

5. **Rollback** (if needed):
   ```bash
   npm run migration:revert
   ```

### Baseline Migration

This repository includes an initial baseline migration
(`src/migrations/1719619200000-CreateInitialSchema.ts`) that captures the
full current schema (User, Song, Album, Genre, TransactionLog, RoyaltyPayout).
The first deployment to a new database will run this migration to set up all
tables and indexes.

## Documentation

Additional in-repo docs live under [`docs/`](docs/):

- [Deployment & Scaling Guide](docs/deployment-and-scaling.md) — expected
  CPU/memory sizing for the API and the ffmpeg-backed worker, how to measure
  it, and how to scale each process (Issue #405)
- [Logging & Aggregation Guide](docs/logging-and-aggregation.md) — centralized log shipping to Grafana Loki via Promtail, LogQL queries, and sensitive data redaction (Issue #380)
- [Architecture](docs/ARCHITECTURE.md) — high-level module layout
- [AI Feature Set](docs/AI_FEATURES.md) — AI capabilities, what data is sent
  where, and the per-artist opt-in/opt-out story
- [Privy Migration Guide](docs/PRIVY_MIGRATION_GUIDE.md) — how existing
  accounts and sessions move to Privy-backed authentication (Issue #637)
- [Database Schema](docs/database-schema.md) & [Migrations](docs/migrations.md)
- [Conventions](docs/conventions.md), [ADR catalog](docs/adrs/), and the
  [OpenAPI spec](docs/openapi.yaml)

## Getting Started

### One-Command Local Bootstrap (Recommended)

To spin up container dependencies (PostgreSQL, Redis, RabbitMQ), apply pending schema migrations, seed genres, and populate representative test accounts (admin, artists, listeners, albums, tracks) in one step (Issue #369):

```bash
cp .env.example .env
npm run dev:bootstrap
npm run dev
```

This command is **100% idempotent** — running it multiple times safely re-verifies schema and seeds without duplicate errors.

### With Docker (Manual)

```bash
git clone <repo-url>
cd AudioBlock_Backend
cp .env.example .env.docker   # fill in the values above
docker compose up --build     # minimal stack: API + Postgres + Redis
```

This brings up the **minimal stack** (API `localhost:4000` + Postgres `5432` + Redis `6379`) with hot-reload via `docker-compose.override.yml`. For contributors only touching the API, this is the fastest path and avoids running observability/queue infrastructure.

#### Profiles — minimal vs full

`docker-compose.yml` uses Compose **profiles** so the same file serves both use-cases:

| Command                                             | What it starts                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `docker compose up --build`                         | `backend` + `db` + `redis` (minimal, no profile)                                                |
| `docker compose --profile full up --build`          | Everything: minimal + `rabbitmq` + `pgadmin` + `prometheus` + `grafana` + `loki` + `promtail`   |
| `docker compose --profile queue up --build`         | Minimal + `rabbitmq` (song-processing queue)                                                    |
| `docker compose --profile tools up --build`         | Minimal + `pgadmin` (`localhost:5050`)                                                          |
| `docker compose --profile monitoring up --build`    | Minimal + `prometheus` (`9090`) + `grafana` (`3000`) + `loki` (`3100`) + `promtail`            |
| `docker compose --profile observability up --build` | Same as `monitoring` (alias)                                                                    |

`backend` no longer `depends_on: rabbitmq` — the API starts without a queue and connects to RabbitMQ lazily when it appears (see `src/index.ts`), so the minimal stack stays self-contained. Any combination of profiles can be stacked, e.g.:

```bash
docker compose --profile queue --profile monitoring up --build
# → backend + db + redis + rabbitmq + prometheus + grafana + loki + promtail
```

The full observability stack (`--profile full`) is unchanged from the pre-profile `docker compose up` topology and is what CI and `docker-compose.prod.yml` extend.

#### Docker Compose consistency (Issue #404)

The repo tracks five compose files — `docker-compose.yml` (base),
`docker-compose.dev.yml`, `docker-compose.override.yml`,
`docker-compose.prod.yml`, and `docker-compose.test.yml`. The base file is the
source of truth for the full topology; overlay files only extend it. To keep
the files from silently drifting apart (e.g. an env var added to one but not
the others):

```bash
npm run compose:check
```

The script fails (exit 1) if an overlay references a service the base file does
not define, or if an overlay sets an environment key that the base file has
never declared. It is also run automatically in CI, so a PR that introduces
drift will be caught before merge.

### Without Docker

Requires a running PostgreSQL, Redis, and RabbitMQ instance, plus the system
`ffmpeg` binary installed.

```bash
npm install
cp .env.example .env   # fill in the values above
npm run dev
```

## Scripts

| Command                                               | Description                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                         | Hot-reload dev server (`ts-node-dev`)                                                                                           |
| `npm run build`                                       | Compiles TypeScript to `dist/`                                                                                                  |
| `npm start`                                           | Runs the compiled build (`dist/index.js`)                                                                                       |
| `npm run worker`                                      | Runs the song-processing worker as a standalone process, independent of the API process — useful for scaling workers separately |
| `npm run indexer`                                     | Runs the on-chain event indexer as a standalone process, independent of the API — scales the same way as `npm run worker` (alias of `worker:indexer`). Also runs as its own `indexer` service in `docker-compose.yml`. |
| `npm run seed:genres`                                 | Manually re-runs the genre seeder (also runs automatically on every boot)                                                       |
| `npm run migration:generate -- -n DescribeYourChange` | Generates a new migration file based on entity changes                                                                          |
| `npm run migration:run`                               | Applies pending migrations to the database                                                                                      |
| `npm run migration:revert`                            | Reverts the last applied migration                                                                                              |
| `npm test`                                            | Runs the full Jest suite (`src/__tests__/**/*.test.ts`)                                                                         |
| `npm run test:changed`                                | Runs only tests affected by files changed since `main` (for fast local iteration; Issue #397)                                   |
| `npm test -- src/__tests__/health.test.ts`            | Runs a single test file (swap in any path under `src/__tests__`)                                                                |
| `npm run test:watch`                                  | Runs Jest in watch mode                                                                                                         |
| `npm run dev:bootstrap`                               | Bootstraps Docker dependencies, runs migrations, seeds genres and test accounts (Issue #369)                                    |
| `npm run test:load:stream`                            | Runs streaming endpoint load test (Issue #370, see `docs/LOAD_TESTING.md`)                                                      |
| `npm run test:load:upload`                            | Runs chunked upload & finalize endpoint load test (Issue #371, see `docs/LOAD_TESTING.md`)                                      |
| `npm run compose:check`                               | Validates that all docker-compose files are mutually consistent (Issue #404)                                                    |
| `npm run env:check`                                   | Checks that `.env.example` lists every required var from `src/config/env.ts` (reports both missing and extra keys)              |
| `npm run env:check:strict`                            | Same as above but fails on any extra key in `.env.example` (exact parity)                                                       |

## Known Issues / Cleanup Backlog

- `src/routes/twitterRoutesOld.ts` is an unused/superseded code path still present in the repo.
- A handful of variables in `.env.example` (`REDIS_URL`, `JWT_EXPIRER_AT`,
  `PRIVATE_KEY`, `PRIVATE_KEY_2`, several OAuth1-style Twitter vars) are not
  currently read by any code.
