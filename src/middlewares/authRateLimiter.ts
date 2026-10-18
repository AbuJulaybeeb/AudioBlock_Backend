import { createSlidingWindowLimiter } from './rateLimiter';

// Brute-force protection must not disappear when Redis does: these limiters fail
// closed (503 + Retry-After). Set AUTH_RATE_LIMIT_MEMORY_FALLBACK=true to enforce
// per-instance in-memory limits instead, so login keeps working during an outage.
const authLimiterOptions = {
  failureMode: 'closed' as const,
  memoryFallback: process.env.AUTH_RATE_LIMIT_MEMORY_FALLBACK === 'true',
};

const authWindowMs = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10);
const authMax = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '5', 10);

const nonceWindowMs = parseInt(
  process.env.NONCE_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000),
  10,
);
const nonceMax = parseInt(process.env.NONCE_RATE_LIMIT_MAX || '10', 10);

const passwordResetWindowMs = parseInt(
  process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000),
  10,
);
const passwordResetMax = parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || '3', 10);

export const authRateLimiter = createSlidingWindowLimiter(
  authWindowMs,
  authMax,
  'auth:rl',
  (req) => {
    const email =
      req.body?.email ||
      (req.params?.email
        ? Array.isArray(req.params.email)
          ? req.params.email[0]
          : req.params.email
        : '') ||
      'unknown';
    return `auth:rl:${req.ip}:${email}`;
  },
  authLimiterOptions,
);

export const nonceRateLimiter = createSlidingWindowLimiter(
  nonceWindowMs,
  nonceMax,
  'nonce:rl',
  (req) => {
    const email =
      req.body?.email ||
      (req.params?.email
        ? Array.isArray(req.params.email)
          ? req.params.email[0]
          : req.params.email
        : '') ||
      'unknown';
    return `nonce:rl:${req.ip}:${email}`;
  },
  authLimiterOptions,
);

export const passwordResetRateLimiter = createSlidingWindowLimiter(
  passwordResetWindowMs,
  passwordResetMax,
  'pwreset:rl',
  (req) => {
    const email =
      req.body?.email ||
      (req.params?.email
        ? Array.isArray(req.params.email)
          ? req.params.email[0]
          : req.params.email
        : '') ||
      'unknown';
    return `pwreset:rl:${req.ip}:${email}`;
  },
  authLimiterOptions,
);

// 2FA enable/verify/disable (issue #328): previously had no dedicated
// limiter at all beyond requireAuth, unlike every other auth-adjacent
// route in this file — an authenticated attacker could brute-force a TOTP
// code or spam enable/disable toggles with no throttling. Keyed by the
// authenticated user (set by requireAuth), since these routes always run
// after auth and per-user throttling is the meaningful boundary here (an
// IP-only key would let one user with a rotating IP evade it, and would
// also throttle unrelated users sharing a NAT'd IP).
const twoFactorWindowMs = parseInt(
  process.env.TWO_FACTOR_RATE_LIMIT_WINDOW_MS || String(60 * 1000),
  10,
);
const twoFactorMax = parseInt(process.env.TWO_FACTOR_RATE_LIMIT_MAX || '5', 10);

export const twoFactorRateLimiter = createSlidingWindowLimiter(
  twoFactorWindowMs,
  twoFactorMax,
  '2fa:rl',
  (req) => {
    const userId = (req as any).user?.id || 'unknown';
    return `2fa:rl:${userId}`;
  },
);

// GDPR account lifecycle (issue #633). Keyed by authenticated user, since these
// routes always run after requireAuth. The limit is deliberately tight: they are
// the most consequential endpoints in the account system — an attacker holding a
// stolen session could otherwise immediately schedule an irreversible erasure —
// while legitimate use is a handful of requests per user per day.
const accountLifecycleWindowMs = parseInt(
  process.env.ACCOUNT_LIFECYCLE_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000),
  10,
);
const accountLifecycleMax = parseInt(process.env.ACCOUNT_LIFECYCLE_RATE_LIMIT_MAX || '5', 10);

export const accountLifecycleRateLimiter = createSlidingWindowLimiter(
  accountLifecycleWindowMs,
  accountLifecycleMax,
  'account:rl',
  (req) => {
    const userId = (req as any).user?.id || 'unknown';
    return `account:rl:${userId}`;
  },
);
