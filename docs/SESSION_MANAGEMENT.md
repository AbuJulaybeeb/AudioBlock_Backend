# Session Management and Logout

**Status:** Implemented
**Issue:** #608
**Related:** [Privy Authentication](./PRIVY_AUTH.md), [Token Introspection](./TOKEN_INTROSPECTION.md)

## Overview

AudioBlock Backend provides comprehensive session management with support for both legacy (HS256 JWT) and Privy (ES256) authentication tokens. This document covers logout endpoints, session invalidation strategies, and token lifecycle management.

## Session Types

### Legacy Sessions (Pre-Privy)

**Token Format:** HS256 JWT signed with `JWT_SECRET`

**Components:**

- **Access Token:** 15-minute expiry, contains user claims
- **Refresh Token:** 7-day expiry, persisted in `refresh_tokens` table with rotation tracking

**Storage:**

- Access token: Client-side only (localStorage, sessionStorage, memory)
- Refresh token: Database row with `familyId` for reuse detection

### Privy Sessions

**Token Format:** ES256 JWT issued by `privy.io`

**Components:**

- **Access Token:** Privy-issued, verified via JWKS
- **Session ID:** `sid` claim tracks session server-side

**Storage:**

- Access token: Client-side
- Session metadata: Privy manages server-side

## Logout Endpoints

### Legacy Logout

**Endpoint:** `POST /api/auth/logout`

**Authentication:** `requireAuth` (legacy HS256 token)

**Rate Limit:** `authRateLimiter` (5 requests/minute per IP+email)

**Request:**

```bash
POST /api/auth/logout
Authorization: Bearer <legacy_access_token>
```

**Response:**

```json
{
  "success": true,
  "message": "Logout successful"
}
```

**Behavior:**

1. Extracts user ID from authenticated request (`req.user.id`)
2. Calls `AuthService.logout(userId)` which:
   - Revokes all active refresh tokens for the user
   - Deletes rows from `refresh_tokens` table where `user_id` matches
3. Returns success response

**Access Token Handling:**

- Access tokens are **not** revoked server-side (stateless design)
- Client must discard the access token immediately
- Token becomes unusable within 15 minutes (natural expiry)
- Future refresh attempts fail (no valid refresh token in DB)

**Implementation:** `src/controllers/AuthController.ts` → `logout()`

### Privy Logout

**Endpoint:** `POST /api/auth/privy/logout`

**Authentication:** `requirePrivyAuth` (Privy ES256 token)

**Rate Limit:** `authRateLimiter` (5 requests/minute per IP+email)

**Request:**

```bash
POST /api/auth/privy/logout
Authorization: Bearer <privy_access_token>
```

**Response:**

```json
{
  "success": true,
  "message": "Privy logout successful"
}
```

**Behavior:**

1. Extracts Privy user ID from authenticated request (`req.privyUser.id`)
2. Calls `AuthService.privyLogout(privyUserId)` which:
   - Resolves local user ID from `privyUserId`
   - Revokes all local refresh tokens (if any were issued)
   - Optionally calls Privy API to invalidate session (future enhancement)
3. Returns success response

**Session Invalidation:**

- Privy manages session lifecycle server-side
- Client must call Privy SDK's logout method to fully terminate session
- Backend logout clears local state only

**Implementation:** `src/controllers/AuthController.ts` → `privyLogout()`

## Token Invalidation Strategies

### Access Token Invalidation

**Challenge:** JWTs are stateless and cannot be revoked before expiry

**Strategies Implemented:**

#### 1. Short TTL (15 minutes)

- Compromised access tokens expire quickly
- Reduces window of vulnerability
- Requires refresh token for extended sessions

#### 2. Refresh Token Revocation

- Logout revokes all refresh tokens
- Prevents attacker from obtaining new access tokens
- Existing access tokens expire naturally within 15 minutes

#### 3. Client-Side Immediate Discard

- Client deletes access token from storage on logout
- Most attacks require client-side XSS to steal token
- Proper XSS mitigation + immediate discard = effective defense

**Future Enhancement: Token Blocklist (#608 follow-up)**

For high-security scenarios, implement a Redis-based token blocklist:

```typescript
// Pseudocode for future implementation
const BLOCKLIST_KEY_PREFIX = 'blocked-token:';
const BLOCKLIST_TTL_SECONDS = 15 * 60; // Match access token expiry

async function blockToken(tokenJti: string): Promise<void> {
  await redis.set(`${BLOCKLIST_KEY_PREFIX}${tokenJti}`, '1', 'EX', BLOCKLIST_TTL_SECONDS);
}

async function isTokenBlocked(tokenJti: string): Promise<boolean> {
  const blocked = await redis.get(`${BLOCKLIST_KEY_PREFIX}${tokenJti}`);
  return blocked === '1';
}

// In authMiddleware.ts
if (await isTokenBlocked(decodedToken.jti)) {
  throw AppError.authentication('Token has been revoked');
}
```

**Trade-offs:**

- ✅ Immediate revocation of access tokens
- ❌ Every auth check requires Redis lookup (latency + load)
- ❌ Breaks stateless JWT property
- ❌ Must handle Redis failures gracefully

**Recommendation:** Only implement if business requirements demand immediate revocation. Current 15-minute expiry + refresh revocation is sufficient for most use cases.

### Refresh Token Rotation

**Mechanism:** Token families with reuse detection

**Implementation:** `src/services/RefreshTokenService.ts`

**Properties:**

1. **Rotation on Use:**
   - Each refresh generates a new token
   - Old token is invalidated immediately
   - Rotation counter increments

2. **Reuse Detection:**
   - If an old token is replayed, entire family is revoked
   - Prevents token replay attacks
   - Logs security event

3. **Family Lifecycle:**
   - New login creates new family
   - Rotation increments counter, keeps family
   - Max 100 rotations per family (DoS prevention)

**Database Schema:**

```sql
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  family VARCHAR NOT NULL,
  token VARCHAR NOT NULL,
  rotation INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(user_id, family)
);
```

**Example Flow:**

```
Login:
  family=abc, rotation=0, token=token1

First Refresh:
  token1 used → generates token2
  family=abc, rotation=1, token=token2
  token1 deleted

Second Refresh:
  token2 used → generates token3
  family=abc, rotation=2, token=token3
  token2 deleted

Replay Attack:
  token1 used (already deleted)
  → family=abc revoked entirely
  → All tokens (including token3) invalidated
  → User must re-login
```

## Session Invalidation Scenarios

### User-Initiated Logout

**Trigger:** User clicks "Logout" button

**Actions:**

1. Client calls `POST /api/auth/logout` or `POST /api/auth/privy/logout`
2. Server revokes all refresh tokens
3. Client deletes access token from storage
4. Client redirects to login page

**Outcome:** All devices logged out within 15 minutes

### Logout All Devices

**Endpoint:** `POST /api/auth/logout` (current implementation logs out all devices)

**Future Enhancement:** Per-device session management

```typescript
// Pseudocode for future per-device logout
POST /api/auth/sessions
→ Returns list of active sessions (by refresh token family)

POST /api/auth/sessions/:familyId/revoke
→ Revokes specific session (specific refresh token family)

POST /api/auth/sessions/revoke-all
→ Revokes all sessions except current one
```

### Admin-Initiated Logout

**Scenario:** Support agent needs to force logout a compromised account

**Current Workaround:**

```sql
-- Revoke all refresh tokens for user
DELETE FROM refresh_tokens WHERE user_id = '<user_id>';
```

**Future Enhancement:** Admin API endpoint

```typescript
POST /api/admin/users/:userId/sessions/revoke
Authorization: Bearer <admin_token>
→ Revokes all sessions for target user
→ Logs admin action for audit trail
```

### Password Change / Security Event

**Recommended:** Revoke all sessions on password change

**Implementation:**

```typescript
// In AuthService.resetPassword()
async resetPassword(token: string, newPassword: string): Promise<void> {
  const user = await this.verifyResetToken(token);
  await this.updatePassword(user.id, newPassword);

  // Revoke all sessions after password change
  await this.refreshTokenService.revokeAllUserTokens(user.id);

  logger.info({ userId: user.id }, 'All sessions revoked after password reset');
}
```

**Rationale:**

- User who initiated password change must re-login (expected)
- Attacker who changed password is immediately locked out
- Legitimate user can re-login with new password

## Client-Side Session Management

### Access Token Storage

**Recommended: Memory-only (most secure)**

```typescript
// Store token in memory variable
let accessToken: string | null = null;

function setAccessToken(token: string) {
  accessToken = token;
}

function getAccessToken(): string | null {
  return accessToken;
}

function clearAccessToken() {
  accessToken = null;
}
```

**Trade-off:** Tokens lost on page refresh

**Solution:** Store refresh token in httpOnly cookie, fetch new access token on page load

### Refresh Token Storage

**Option 1: httpOnly Cookie (recommended)**

```typescript
// Server sets httpOnly cookie on login
res.cookie('refreshToken', token, {
  httpOnly: true,
  secure: true, // HTTPS only
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
});

// Client sends cookie automatically
POST /api/auth/refresh
→ Cookie sent in request headers
→ New access token returned
```

**Pros:**

- Immune to XSS (JavaScript cannot read httpOnly cookies)
- Automatic transmission with requests
- Secure by default

**Cons:**

- CSRF risk (mitigated with sameSite=strict + CSRF token)
- Cross-domain complexity

**Option 2: localStorage (acceptable with XSS protections)**

```typescript
// Store in localStorage
localStorage.setItem('refreshToken', token);

// Retrieve for refresh
const refreshToken = localStorage.getItem('refreshToken');

// Delete on logout
localStorage.removeItem('refreshToken');
```

**Pros:**

- Simple implementation
- Works cross-domain

**Cons:**

- Vulnerable to XSS attacks
- Accessible to all scripts on same origin

**XSS Mitigations (if using localStorage):**

- Content Security Policy (CSP)
- Input sanitization
- Output encoding
- Trusted library dependencies only

## Logout Best Practices

### Server-Side

1. **Always revoke refresh tokens** — Never leave orphaned tokens in database
2. **Log logout events** — Audit trail for security investigations
3. **Rate limit logout endpoint** — Prevent DoS via logout spam
4. **Return success even if token already revoked** — Idempotent behavior

### Client-Side

1. **Immediately discard access token** — Don't wait for server response
2. **Clear all local storage** — Remove any cached user data
3. **Redirect to login page** — Prevent accidental authenticated actions
4. **Call Privy SDK logout** — For Privy sessions, terminate session fully

### Security

1. **Never log tokens** — Access/refresh tokens are secrets
2. **Use HTTPS** — Tokens in transit must be encrypted
3. **Validate token expiry** — Reject expired tokens before processing logout
4. **Prevent CSRF** — Use CSRF tokens or origin validation

## Testing Logout Flows

### Unit Tests

```typescript
describe('AuthController.logout', () => {
  it('should revoke all refresh tokens on logout', async () => {
    const user = await createTestUser();
    const { refreshToken } = await authService.login(user.email, password);

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const tokens = await refreshTokenRepo.find({ where: { userId: user.id } });
    expect(tokens).toHaveLength(0);
  });

  it('should return success even if no refresh tokens exist', async () => {
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });
});
```

### Integration Tests

```typescript
describe('Logout Flow', () => {
  it('should prevent token refresh after logout', async () => {
    const { accessToken, refreshToken } = await loginUser();

    // Logout
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Try to refresh
    await request(app).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('should allow re-login after logout', async () => {
    const user = await createTestUser();
    const { accessToken } = await loginUser(user.email, password);

    // Logout
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Re-login
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(200);

    expect(response.body.accessToken).toBeDefined();
  });
});
```

## Monitoring and Metrics

### Key Metrics

```prometheus
# Total logout requests
auth_logout_total{method="legacy"} 1234
auth_logout_total{method="privy"} 567

# Logout errors
auth_logout_errors_total{method="legacy", reason="invalid_token"} 12

# Active sessions (refresh tokens not expired)
auth_active_sessions_count 4567
```

### Recommended Alerts

```yaml
- alert: HighLogoutErrorRate
  expr: rate(auth_logout_errors_total[5m]) > 0.1
  annotations:
    summary: 'Logout error rate >10% for 5 minutes'

- alert: SuspiciousLogoutVolume
  expr: rate(auth_logout_total[1m]) > 100
  annotations:
    summary: 'Logout spike: >100 req/min (possible DoS or security incident)'
```

## Related Documentation

- [Privy Authentication](./PRIVY_AUTH.md)
- [Privy Implementation](./PRIVY_AUTH_IMPLEMENTATION.md)
- [Token Introspection](./TOKEN_INTROSPECTION.md)
- [Rate Limiting](./RATE_LIMITING.md)
- Issue #608: Implement logout/session invalidation endpoint
- Issue #630: Session refresh token rotation


### Privy revocation storage

Privy revocations are shared through Redis across API instances and restarts. Per-session keys `privy:revoked:<sid>` expire after the token's remaining lifetime. Per-user keys `privy:revoked-user:<userId>` store an epoch-seconds cutoff: tokens issued before it are rejected, including previously unseen sessions. User cutoffs are retained indefinitely because no maximum token lifetime is assumed. Configure Redis persistence and retention so these security records survive Redis restarts; do not use an eviction policy that discards revocations.

`PRIVY_REVOCATION_FAILURE_MODE=closed` is the default: Redis errors or a lookup exceeding two seconds reject authentication. Set it to `open` explicitly to accept otherwise-valid tokens during an outage, at the cost of temporarily accepting revoked tokens. Revocation writes always propagate failures so a failed write cannot be reported as successful. Redis TTL replaces the old process cleanup timer. The legacy JWT refresh flow is unchanged.
