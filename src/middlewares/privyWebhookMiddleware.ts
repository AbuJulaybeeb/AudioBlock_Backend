import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import logger from '../config/logger';

/**
 * Middleware to verify Privy webhook signatures (Issue #606).
 *
 * Privy signs webhook payloads using HMAC-SHA256 with your app secret.
 * This middleware verifies the signature before processing the webhook.
 *
 * The signature is sent in the `privy-signature` header in the format:
 * `t=<timestamp>,v1=<signature>`
 *
 * Security considerations:
 * - Timestamp check prevents replay attacks (5-minute window)
 * - Constant-time comparison prevents timing attacks
 * - Signature verification ensures payload integrity
 */
export function verifyPrivyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers['privy-signature'] as string;
  const appSecret = process.env.PRIVY_APP_SECRET;

  if (!appSecret) {
    logger.error('PRIVY_APP_SECRET not configured');
    return handleError(req, res, AppError.businessLogic('Privy webhooks not configured'));
  }

  if (!signature) {
    logger.warn('Missing Privy webhook signature');
    return handleError(req, res, AppError.authentication('Missing webhook signature'));
  }

  try {
    // Parse signature header: t=<timestamp>,v1=<signature>
    const parts = signature.split(',');
    const timestampPart = parts.find((p) => p.startsWith('t='));
    const signaturePart = parts.find((p) => p.startsWith('v1='));

    if (!timestampPart || !signaturePart) {
      throw new Error('Invalid signature format');
    }

    const timestamp = parseInt(timestampPart.split('=')[1], 10);
    const expectedSignature = signaturePart.split('=')[1];

    // Check timestamp (prevent replay attacks - 5 minute tolerance)
    const currentTime = Math.floor(Date.now() / 1000);
    const tolerance = 5 * 60; // 5 minutes

    if (Math.abs(currentTime - timestamp) > tolerance) {
      logger.warn({ timestamp, currentTime }, 'Webhook timestamp outside tolerance window');
      return handleError(req, res, AppError.authentication('Webhook timestamp expired'));
    }

    // Compute expected signature
    const payload = JSON.stringify(req.body);
    const signedPayload = `${timestamp}.${payload}`;
    const computedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(signedPayload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(computedSignature))) {
      logger.warn('Invalid Privy webhook signature');
      return handleError(req, res, AppError.authentication('Invalid webhook signature'));
    }

    // Signature is valid, proceed to webhook handler
    next();
  } catch (error) {
    logger.error({ err: error }, 'Error verifying Privy webhook signature');
    return handleError(req, res, AppError.authentication('Failed to verify webhook signature'));
  }
}

export const verifyPrivyWebhook = verifyPrivyWebhookSignature;
