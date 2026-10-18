import { Request, Response, NextFunction } from 'express';
import { isLegacyEvmAuthEnabled } from '../config/authFlags';

/**
 * Gate for the legacy EVM wallet-signature login and Dynamic Labs wallet
 * routes (Issue #809). Passes through when `ENABLE_LEGACY_EVM_AUTH=true`;
 * otherwise answers `410 Gone` with a hint to use Privy.
 */
export function requireLegacyEvmAuth(_req: Request, res: Response, next: NextFunction): void {
  if (isLegacyEvmAuthEnabled()) {
    return next();
  }

  res.status(410).json({
    success: false,
    message:
      'EVM wallet authentication has been retired. Sign in with Privy (POST /api/auth/privy/login) or email and password instead.',
    type: 'GONE',
  });
}
