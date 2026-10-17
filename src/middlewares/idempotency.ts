/**
 * Idempotency middleware (#336).
 *
 * Deduplicates repeated requests to mutating endpoints by caching the
 * response under an `Idempotency-Key` header. A repeated request with the
 * same key within the TTL window returns the original response without
 * re-executing the handler.
 *
 * Usage:
 *   router.post('/mint/:id', idempotency({ ttlMs: 60000 }), handler);
 *
 * The key is scoped to the user (from `req.user.id` or `req.ip`) so one
 * client cannot replay another's request.
 */
import type { Request, Response, NextFunction } from 'express';
import redis from '../config/redis';
import logger from '../config/logger';

const DEFAULT_TTL_SECONDS = 60; // 1 minute dedup window

interface IdempotencyOptions {
  /** How long to remember a completed request (default 60s). */
  ttlMs?: number;
  /** Header name to read the key from (default "Idempotency-Key"). */
  header?: string;
}

/**
 * Capture the response body/status under the idempotency key so replays
 * return the original result.
 */
async function cacheResponse(
  key: string,
  statusCode: number,
  body: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(
      key,
      JSON.stringify({ statusCode, body }),
      'EX',
      ttlSeconds,
    );
  } catch (err) {
    logger.warn({ err, key }, 'Idempotency cache write failed');
  }
}

/**
 * Check if a request with this key has already been processed. If so,
 * replay the cached response and skip the handler.
 */
export function idempotency(options: IdempotencyOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_SECONDS * 1000;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  const headerName = options.header ?? 'Idempotency-Key';

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers[headerName.toLowerCase()] as string | undefined;
    if (!key) {
      // No key provided — proceed normally (idempotency is opt-in).
      return next();
    }

    // Scope the key to the user so clients cannot collide.
    const userId = (req as any).user?.id || req.ip || 'anonymous';
    const cacheKey = `idempotency:${userId}:${req.method}:${req.path}:${key}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const { statusCode, body } = JSON.parse(cached);
        logger.info({ key, path: req.path }, 'Idempotent replay — returning cached response');
        return res.status(statusCode).json(body);
      }
    } catch (err) {
      logger.warn({ err, key }, 'Idempotency cache read failed — proceeding as new request');
    }

    // Intercept res.json to capture the response for caching.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // Only cache successful responses (2xx) — failures should be retried.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void cacheResponse(cacheKey, res.statusCode, body, ttlSeconds);
      }
      return originalJson(body);
    };

    next();
  };
}
