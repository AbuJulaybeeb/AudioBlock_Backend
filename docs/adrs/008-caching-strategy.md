# ADR-008: Redis Caching Strategy

**Date:** 2026-08-26
**Status:** Accepted
**Deciders:** Core team

## Context

Redis (`src/config/redis.ts`) is used throughout the backend for several unrelated purposes — ephemeral authentication secrets, derived-data caching, and rate-limit counters — but each use was added independently by different features (wallet login, Twitter OAuth, HLS streaming, search). There is no single document that explains:

- What categories of data live in Redis and why Redis (vs. Postgres or in-memory) was the right store for each
- How TTLs were chosen, and what breaks if they are set too short or too long
- How each category is invalidated, and whether invalidation is TTL-only or also explicit

This gap makes it easy to regress behavior when touching Redis code — e.g. bumping a TTL "to fix a flaky test" without understanding it's a one-time-use security token, or assuming a cached value is safe to read after a write without an explicit invalidation.

This ADR only covers **application-level Redis usage** for caching and ephemeral state. The Redis-backed background job queue (`JobQueueService`) is a durable work queue, not a cache, and is covered by [ADR-004](004-background-job-processing.md).

## Decision

Standardize Redis usage into three categories, each with an explicit TTL policy and invalidation approach:

### 1. One-time security tokens (nonces, OAuth state)

| Key pattern             | Purpose                                                                          | TTL          | Invalidation                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `nonce:<email>`         | Wallet-signature login challenge (`AuthService`, `UserService`, `WalletService`) | 300s (5 min) | Deleted immediately on successful use (`redis.del`); otherwise expires       |
| `twitter:state:<state>` | PKCE code verifier + user id for Twitter OAuth callback (`twitterRoutes`)        | 300s (5 min) | Deleted immediately after the callback consumes it (success or failure path) |

**Why Redis:** these values must be readable from any process handling the follow-up request (the callback may land on a different instance than the one that issued the challenge), must self-expire without a cleanup job, and are cheap, small, single-use lookups — a natural fit for `GET`/`SET EX`/`DEL`.

**TTL rationale:** 5 minutes bounds the window an attacker has to replay a leaked nonce or intercepted OAuth `state`, while remaining long enough for a human to complete a wallet-signing prompt or an OAuth consent screen without hitting a race against normal network/UI latency.

**Invalidation:** always explicit `DEL` on first successful use, in addition to the TTL — these are one-time-use by design, so a value must never be readable twice even within its TTL window. The TTL alone is a fallback for abandoned flows, not the primary invalidation mechanism.

### 2. Derived-data cache (song manifests, artist profiles, genre list)

| Key pattern                             | Purpose                                                                              | TTL                                              | Invalidation                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `manifest:<songId>`                     | Signed HLS manifest for streaming (`precomputeManifest.ts`, `SongController.stream`) | `MANIFEST_CACHE_TTL` env, default 300s           | TTL-only; a stale manifest self-heals by re-signing on next request after expiry |
| `song:<songId>`                         | Song streaming metadata / presigned URLs (`CacheService`)                            | `CACHE_TTL_SONG_MS` env, default 300s (5 min)    | TTL, plus explicit `CacheService.clearSong()` on song update/delete              |
| `artist:<artistId>`                     | Artist profile (`CacheService`)                                                      | `CACHE_TTL_ARTIST_MS` env, default 600s (10 min) | TTL, plus explicit `CacheService.clearArtist()` on profile update                |
| `genres:all`                            | Full genre list (`CacheService`)                                                     | `CACHE_TTL_GENRE_MS` env, default 3600s (1 hr)   | TTL, plus explicit `CacheService.invalidateGenreList()` on genre CRUD            |

**Why Redis:** all of these are read far more often than they change (a manifest is streamed on every playback; a genre list rarely changes), and all are derived from data already durably stored elsewhere (S3 for audio/manifests, Postgres for artist/song/genre records). Redis is disposable by construction here — every `get` path in `CacheService` and `SongController` falls back to regenerating the value on a miss, so Redis is never the source of truth and can be flushed without data loss.

**TTL rationale — signed URLs age out, presigned segments expire, and TTLs are ordered by how expensive/volatile the underlying data is:**

- Manifests and song data (5 min): manifests embed time-limited signed segment URLs, so the cache TTL is kept short and roughly matched to typical signed-URL lifetimes, capping how long a stale/expired signed URL could be served from cache.
- Artist profiles (10 min): change less often than play data, so a longer TTL reduces DB load without users noticing staleness.
- Genre list (1 hr): effectively static reference data; a full hour is an acceptable staleness window in exchange for near-zero DB reads.

**Invalidation:** TTL is the baseline for every entry (nothing here is cached forever), but write paths that can leave a _visibly_ stale cache (a re-uploaded song, an edited artist bio, a genre rename) also call the matching `CacheService.clear*`/`invalidate*` method so the change is visible immediately rather than waiting out the TTL.

### 3. Rate-limit counters

| Key pattern                             | Purpose                                                                         | Window                                     | Invalidation                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `api:rl:*`, `upload:rl:*`, `admin:rl:*` | Sliding-window API rate limits (`rateLimiter.ts`)                               | Configurable via env (default 60s/1hr/60s) | `EXPIRE` set to the window length; sorted-set entries outside the window are trimmed on each request via `ZREMRANGEBYSCORE` |
| `playback:rl:*`                         | Per-song playback rate limit (`playbackRateLimiter.ts`, via `rate-limit-redis`) | 30s, max 1 request                         | Handled by `rate-limit-redis` internally                                                                                    |
| `moderate:bulk:rl:*`                    | Bulk moderation action rate limit (`bulkModerationRateLimiter.ts`)              | Configurable, default 60s                  | Handled by `rate-limit-redis` internally                                                                                    |
| `play:throttle:<ip>:<songId>`           | De-dupes play-count increments per IP+song (`SongController.stream`)            | 30s                                        | TTL-only                                                                                                                    |

**Why Redis:** rate limiting must be correct across all app instances (a single process's in-memory counter would let a client bypass limits by hitting different instances), and Redis's atomicity (pipelines, `INCR`, sorted sets) makes race-free counting straightforward.

**TTL rationale:** each counter's TTL equals its rate-limit window — once the window closes, the counter's data has no further meaning and should disappear rather than accumulate.

**Invalidation:** TTL-only. All rate limiter code fails open on Redis errors (see `rateLimiter.ts`) so a Redis outage degrades to "no rate limiting" rather than blocking traffic.

## Consequences

### Positive

- A single reference for "why is this TTL what it is" — future changes to a TTL can be checked against the rationale here instead of guessed at
- Makes explicit which categories are safe to flush (derived-data cache, rate limits) versus which would break in-flight user flows if flushed (nonces, OAuth state — a flush mid-login forces the user to restart)
- Clarifies that `CacheService`-style entries are never a source of truth, which should guide future cache additions to follow the same "TTL + explicit invalidation on write" pattern

### Negative / trade-offs

- TTL values are scattered across env vars and hardcoded constants (`AuthService`, `twitterRoutes`, `precomputeManifest.ts`, `CacheService`) rather than centralized; this ADR documents the current state but does not consolidate them into one config module
- Several `CacheService` invalidation call sites were not verified as part of this ADR (i.e., we did not audit every song/artist/genre write path to confirm `clear*` is actually called everywhere it should be) — this is a documentation pass, not a correctness audit
- No cache versioning/namespacing scheme exists, so a schema change to cached data (e.g., the shape of a cached artist profile) relies on the TTL expiring naturally rather than an instant cache-wide invalidation

### Neutral

- The Redis-backed job queue (`JobQueueService`) is Redis-resident but is not a "cache" in the sense this ADR covers — it is documented here only to draw the boundary, and is detailed in [ADR-004](004-background-job-processing.md)

## Alternatives considered

| Option                                                          | Why rejected                                                                                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-memory (per-process) caching for derived data                | Fails immediately in a multi-instance deployment: each instance would have its own stale view, and rate limits/nonces could be trivially bypassed by hitting a different instance |
| Centralizing all TTLs into one `cacheTtls.ts` config module now | Valuable but out of scope for this ADR, which documents the existing strategy; tracked as a follow-up rather than bundled into a docs-only change                                 |
| Longer TTLs across the board to reduce DB/Redis load            | Rejected for nonces/OAuth state (security exposure window) and for manifests (risk of serving cache entries pointing at expired signed URLs)                                      |
