import { Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import { privyService, PrivyService } from '../services/PrivyService';
import { privySessionService } from '../services/privy/PrivySessionService';
import logger from '../config/logger';

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw AppError.authentication(
      'Unauthorized: No token provided',
      undefined,
      'PRIVY_TOKEN_MISSING',
    );
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw AppError.authentication(
      'Unauthorized: No token provided',
      undefined,
      'PRIVY_TOKEN_MISSING',
    );
  }
  return token;
}

/**
 * MFA endpoints for Privy-authenticated requests (issue #639).
 * Enrollment itself happens in Privy's client SDK; these routes expose the
 * backend-side view (status) and an emergency session revocation.
 */
export class PrivyMfaController {
  constructor(private readonly service: PrivyService = privyService) {}

  status = async (req: Request, res: Response) => {
    try {
      const claims = this.service.verifyAccessToken(extractBearerToken(req));
      const mfa = await this.service.getMfaStatus(claims.sub);
      res.status(200).json({
        success: true,
        message: 'MFA status retrieved',
        sessionId: claims.sid ?? null,
        ...mfa,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  revokeSessions = async (req: Request, res: Response) => {
    try {
      const claims = this.service.verifyAccessToken(extractBearerToken(req));

      // Revoke on Privy's side (server-side, affects all sessions)
      await this.service.revokeAllSessions(claims.sub);

      // Track revocation locally for early rejection (Issue #625)
      await privySessionService.revokeUserSessions(claims.sub);

      logger.info({ privyUserId: claims.sub }, 'Revoked all Privy sessions');

      res.status(200).json({
        success: true,
        message: 'All Privy sessions revoked',
        privyUserId: claims.sub,
      });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}

export const privyMfaController = new PrivyMfaController();
