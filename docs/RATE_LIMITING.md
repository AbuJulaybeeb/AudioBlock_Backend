# Rate Limiting

**Status:** Implemented
**Issue:** #607
**Related:** [Authentication Strategy](./adrs/001-authentication-strategy.md)

## Overview

AudioBlock Backend implements comprehensive rate limiting across all authentication endpoints to prevent:

- Credential stuffing attacks
- Email enumeration
- Brute-force password attempts
- Token exhaustion attacks
- Account lifecycle abuse

## Implementation

Rate limiting uses Redis-backed sliding window counters, providing:

- **Distributed enforcement** across multiple API instances
- **Precise limits** without bucket quantization errors
- **Configurable Redis-outage behavior** per limiter (fail open or fail closed, see [Redis Unavailable](#redis-unavailable))

### Core Middleware

`src/middlewares/rateLimiter.ts` provides `createSlidingWindowLimiter`:

```typescript
export const createSlidingWindowLimiter = (
  windowMs: number,
  max: number,
  prefix: string,
  keyGenerator: (req: Request) => string,
) => {
  // Returns Express middleware
};
```

### Rate Limiter Types

`src/middlewares/authRateLimiter.ts` defines specialized limiters:

#### 1. Authentication Rate Limiter

**Applied to:** Login, registration, token refresh, logout, password reset endpoints

**Key:** `auth:rl:${IP}:${email}` — Combined IP + email to prevent both:

- Single IP attacking multiple accounts
- Distributed attacker targeting one account

**Default Limits:**

- Window: 1 minute (60,000 ms)
- Max Requests: 5

**Configuration:**

```bash
AUTH_RATE_LIMIT_WINDOW_MS=60000  # 1 minute
AUTH_RATE_LIMIT_MAX=5
```

**Endpoints:**

- `POST /api/auth/register`
- `POST /api/auth/register-listener`
- `POST /api/auth/login`
- `POST /api/auth/login-email`
- `POST /api/auth/register-email`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/reset-password/:token`
- `POST /api/auth/2fa/validate`
- `POST /api/auth/privy/login`
- `POST /api/auth/privy/refresh-token`
- `POST /api/auth/privy/logout`
- `GET /api/auth/mfa/status`
- `POST /api/auth/mfa/sessions/revoke`

#### 2. Nonce Rate Limiter

**Applied to:** Nonce generation endpoint (wallet signature challenges)

**Key:** `nonce:rl:${IP}:${email}` — Prevents email enumeration via nonce requests

**Default Limits:**

- Window: 15 minutes (900,000 ms)
- Max Requests: 10

**Configuration:**

```bash
NONCE_RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
NONCE_RATE_LIMIT_MAX=10
```

**Endpoints:**

- `GET /api/auth/nonce/:email`

**Rationale:** Stricter than general auth limiter because nonce generation reveals whether an email exists in the system. Lower limit prevents bulk enumeration.

#### 3. Password Reset Rate Limiter

**Applied to:** Forgot password endpoint

**Key:** `pwreset:rl:${IP}:${email}` — Prevents inbox flooding and reset token exhaustion

**Default Limits:**

- Window: 1 hour (3,600,000 ms)
- Max Requests: 3

**Configuration:**

```bash
PASSWORD_RESET_RATE_LIMIT_WINDOW_MS=3600000  # 1 hour
PASSWORD_RESET_RATE_LIMIT_MAX=3
```

**Endpoints:**

- `POST /api/auth/forgot-password`

**Rationale:** Extremely tight limit because:

1. Legitimate users rarely need >3 resets per hour
2. Prevents attacker from flooding user's inbox
3. Mitigates token brute-forcing via email collection

#### 4. Two-Factor Authentication Rate Limiter

**Applied to:** 2FA enable, verify, disable endpoints (Issue #328)

**Key:** `2fa:rl:${userId}` — Per-authenticated-user limit

**Default Limits:**

- Window: 1 minute (60,000 ms)
- Max Requests: 5

**Configuration:**

```bash
TWO_FACTOR_RATE_LIMIT_WINDOW_MS=60000  # 1 minute
TWO_FACTOR_RATE_LIMIT_MAX=5
```

**Endpoints:**

- `POST /api/auth/2fa/enable` (requires `requireAuth`)
- `POST /api/auth/2fa/verify` (requires `requireAuth`)
- `POST /api/auth/2fa/disable` (requires `requireAuth`)

**Rationale:**

- Keyed by authenticated user (not IP) because these routes always run after `requireAuth`
- Prevents TOTP brute-forcing (6-digit codes = 1M possibilities)
  ccount/cancel-deletion`

**Rationale:**

- Most consequential endpoints in the account system
- Stolen session could immediately schedule irreversible erasure
- Legitimate use is handful of requests per user per day
- Tighter than general auth limiter

## Response Behavior

### Rate Limit Exceeded

**Status:** `429 Too Many Requests`

**Headers:**

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1633029600  # Unix timestamp
Retry-After: 45  # Seconds until window resets
```

**Body:**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later",
    "details": {
      "retryAfter": 45
    }
  }
}
```

### Rate Limit Within Bounds

**Headers:**

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 3
```

No rate limit error; request proceeds normally.

### Redis Unavailable

`createSlidingWindowLimiter` takes an optional `failureMode` (`'open'` by default) and `memoryFallback`:

```typescript
createSlidingWindowLimiter(windowMs, max, prefix, keyGenerator, {
  failureMode: 'closed',
  memoryFallback: false,
});
```

| Limiters                                | `failureMode` | Behavior when Redis is down                               |
| --------------------------------------- | ------------- | --------------------------------------------------------- |
| General API, upload, admin, comment, AI | `open`        | Request allowed                                           |
| Auth, nonce, password reset             | `closed`      | `503` with `Retry-After` (or in-memory limits, see below) |

Failing open keeps the API available, but a Redis outage (or an attacker who can cause one) would disable brute-force protection on login, nonce and password-reset endpoints, so those fail closed.

**In-memory fallback (opt-in):** with `memoryFallback: true` a `closed` limiter enforces the same window and max per API instance instead of returning `503`. Set `AUTH_RATE_LIMIT_MEMORY_FALLBACK=true` to enable it for the auth, nonce and password-reset limiters.

Trade-off: the hard `503` guarantees no auth traffic is served unthrottled but blocks logins for the whole outage. The in-memory fallback keeps login working, but limits are per instance, so an attacker's effective budget is multiplied by the number of instances (and resets on restart).

**Response (closed, no fallback):** `503` with `Retry-After` (window length, capped at 30 seconds).

**Observability:** every fallback logs a `warn` ("Rate limiter Redis unavailable, using fallback") and increments `rate_limit_fallbacks_total{limiter, mode}` where `mode` is `open`, `closed` or `memory`.

## Sliding Window Algorithm

**Advantages over fixed windows:**

- No "reset-induced burst": requests spread evenly across time
- Precise enforcement: `max` requests per `windowMs`, sliding continuously
- No edge-case exploits from window boundaries

**Implementation:**

1. Each request adds a timestamped entry to a Redis sorted set
2. Entries older than `windowMs` are pruned
3. Count remaining entries
4. If `count < max`, allow request and add new entry
5. If `count >= max`, reject with 429

**Redis Key Pattern:**

```
rate-limit:{prefix}:{key}
```

**TTL:** Automatically expires after `windowMs + 10 seconds` to prevent memory leaks

## Monitoring and Metrics

### Prometheus Metrics

```prometheus
# Total rate limit rejections by limiter type
rate_limit_rejections_total{limiter="auth"} 1234
rate_limit_rejections_total{limiter="nonce"} 56
rate_limit_rejections_total{limiter="pwreset"} 12

# Rate limiter invocations (allowed + rejected)
rate_limit_requests_total{limiter="auth", outcome="allowed"} 98765
rate_limit_requests_total{limiter="auth", outcome="rejected"} 1234
```

### Recommended Alerts

```yaml
- alert: HighRateLimitRejectionRate
  expr: rate(rate_limit_rejections_total[5m]) > 10
  for: 5m
  annotations:
    summary: 'Rate limit rejecting >10 req/sec for 5 minutes'
    description: 'Possible credential stuffing attack or misconfigured client'

- alert: RateLimitRedisUnavailable
  expr: rate(rate_limit_fallbacks_total[1m]) > 0
  for: 1m
  annotations:
    summary: 'Rate limiter cannot reach Redis'
    description: 'Open limiters allow all traffic; closed limiters reject or use per-instance memory limits'
```

## Testing Rate Limits

### Manual Testing

```bash
# Test auth rate limiter (5 requests/minute)
for i in {1..6}; do
  curl -X POST http://localhost:4000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}' \
    -w "\nStatus: %{http_code}\n"
done

# Expected: First 5 return 401 (invalid creds), 6th returns 429 (rate limited)
```

### Integration Tests

```typescript
describe('Rate Limiting', () => {
  it('should rate limit auth endpoints after max requests', async () => {
    const email = 'ratelimit@example.com';
    const maxRequests = 5;

    // Make max allowed requests
    for (let i = 0; i < maxRequests; i++) {
      await request(app).post('/api/auth/login').send({ email, password: 'wrong' }).expect(401);
    }

    // Next request should be rate limited
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong' })
      .expect(429);

    expect(response.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
```

## Bypass Considerations

### Trusted Internal Services

Internal services (e.g., admin tools, monitoring) can bypass rate limits via:

**Option 1:** Dedicated `/internal/*` routes without rate limiters

**Option 2:** API key-based bypass (future enhancement)

```typescript
// Pseudocode for future implementation
if (req.headers['x-api-key'] === process.env.INTERNAL_API_KEY) {
  return next(); // Skip rate limiter
}
```

### Development/Testing

**Disable rate limiting for tests:**

```bash
# In test environment
NODE_ENV=test
RATE_LIMIT_BYPASS=true  # Future: bypass all rate limiters
```

## Security Best Practices

1. **Never log email addresses in rate limit keys** — Use hashed values in metrics/logs
2. **Monitor rejection rates** — Spike indicates attack or misconfigured client
3. **Coordinate with WAF** — Application-layer rate limiting complements edge protection
4. **Adjust limits per environment** — Staging/dev can have looser limits for testing
5. **Document bypass mechanisms** — Internal tools need escape hatches without weakening public limits

## Tuning Recommendations

### High-Traffic Production

```bash
# More lenient for legitimate high-usage patterns
AUTH_RATE_LIMIT_WINDOW_MS=60000   # 1 minute
AUTH_RATE_LIMIT_MAX=10            # 10 requests/min

NONCE_RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
NONCE_RATE_LIMIT_MAX=20            # 20 requests/15min
```

### High-Security / Known Attack Target

```bash
# Stricter limits during active attack
AUTH_RATE_LIMIT_WINDOW_MS=300000   # 5 minutes
AUTH_RATE_LIMIT_MAX=3              # 3 requests/5min

PASSWORD_RESET_RATE_LIMIT_MAX=1    # 1 request/hour
```

### Development/Staging

```bash
# Relaxed for testing, NOT for production
AUTH_RATE_LIMIT_MAX=100
NONCE_RATE_LIMIT_MAX=100
PASSWORD_RESET_RATE_LIMIT_MAX=10
```

## Related Documentation

- [ADR-001: Authentication Strategy](./adrs/001-authentication-strategy.md)
- [Privy Authentication](./PRIVY_AUTH.md)
- [Environment Variables](./environment-variables.md)
- Issue #29: Rate limiting for auth endpoints
- Issue #102: Tighter limits for password reset
- Issue #328: 2FA rate limiting
- Issue #607: Comprehensive rate limiting documentation
