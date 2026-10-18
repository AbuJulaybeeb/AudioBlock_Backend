import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { privyMfaController } from '../controllers/PrivyMfaController';
import { requireAuth } from '../middlewares/authMiddleware';
import { requirePrivyAuth } from '../middlewares/privyMiddleware';
import { requireLegacyEvmAuth } from '../middlewares/legacyEvmGate';
import {
  authRateLimiter,
  nonceRateLimiter,
  passwordResetRateLimiter,
  twoFactorRateLimiter,
} from '../middlewares/authRateLimiter';

const authController = new AuthController();
const router = Router();

// Apply IP+email-keyed rate limiting to all auth routes (Issue #29).
// /nonce/:email gets its own, stricter limiter to prevent email enumeration.
// The wallet-signature endpoints are legacy EVM auth and answer 410 unless
// ENABLE_LEGACY_EVM_AUTH=true (Issue #809).
router.get('/nonce/:email', requireLegacyEvmAuth, nonceRateLimiter, authController.getUserNonce);
router.post('/register', requireLegacyEvmAuth, authRateLimiter, authController.register);
router.post(
  '/register-listener',
  requireLegacyEvmAuth,
  authRateLimiter,
  authController.registerListener,
);
router.post('/login', requireLegacyEvmAuth, authRateLimiter, authController.login);

// Email + password auth (no wallet signature required) — coexists with the
// wallet-signature flow above. Either path issues the same JWT shape.
router.post('/register-email', authRateLimiter, authController.registerWithEmail);
router.post('/login-email', authRateLimiter, authController.loginWithEmail);
router.post('/refresh', authRateLimiter, authController.refreshToken);
router.post('/logout', authRateLimiter, authController.logout);
// Token introspection for internal services (RFC 7662)
router.post('/introspect', authController.introspect);
// Issue #328: rate-limited per authenticated user — previously unthrottled.
router.post('/2fa/enable', requireAuth, twoFactorRateLimiter, authController.enableTwoFactor);
router.post('/2fa/verify', requireAuth, twoFactorRateLimiter, authController.verifyTwoFactor);
router.post('/2fa/disable', requireAuth, twoFactorRateLimiter, authController.disableTwoFactor);
router.post('/2fa/validate', authRateLimiter, authController.validateTwoFactor);

// Privy MFA (issue #639): authenticated with a Privy access token in the
// Authorization header (ES256/EdDSA), not the legacy HS256 JWT.
router.get('/mfa/status', authRateLimiter, privyMfaController.status);
router.post('/mfa/sessions/revoke', authRateLimiter, privyMfaController.revokeSessions);

// Email verification
router.get('/verify-email/:token', authController.verifyEmail);

// Password reset
// /forgot-password is throttled to 3 requests/hour/email (Issue #102) to prevent
// inbox flooding and reset-token brute-forcing.
router.post('/forgot-password', passwordResetRateLimiter, authController.forgotPassword);
router.post('/reset-password/:token', authRateLimiter, authController.resetPassword);

// Privy authentication endpoints (Issues #627, #628, #629, #630)
router.post('/privy/login', authRateLimiter, authController.privyLogin);
router.post(
  '/privy/refresh-token',
  authRateLimiter,
  requirePrivyAuth,
  authController.privyRefreshToken,
);
router.post('/privy/logout', authRateLimiter, requirePrivyAuth, authController.privyLogout);

export default router;
