import { Request, Response, NextFunction } from 'express';
import redis from '../config/redis';
import { AppError, ErrorType } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import logger from '../config/logger';
import { rateLimitFallbacksTotal } from '../services/MetricsService';

export interface SlidingWindowLimiterOptions {
  /**
   * Behavior when Redis is unavailable. `open` lets the request through;
   * `closed` rejects with 503 (or uses the in-memory fallback if enabled).
   */
  failureMode?: 'open' | 'closed';
  /** In `closed` mode, enforce per-instance limits in memory instead of returning 503. */
  memoryFallback?: boolean;
}

const MEMORY_SWEEP_THRESHOLD = 10_000;
const MAX_UNAVAILABLE_RETRY_AFTER_SEC = 30;

export const createSlidingWindowLimiter = (
  windowMs: number,
  max: number,
  prefix: string,
  keyGenerator?: (req: Request) => string,
  options: SlidingWindowLimiterOptions = {},
) => {
  const { failureMode = 'open', memoryFallback = false } = options;
  // Per-instance sliding window used only when Redis is down in `closed` mode.
  const memoryStore = new Map<string, number[]>();

  const memoryCount = (key: string, now: number): number => {
    if (memoryStore.size > MEMORY_SWEEP_THRESHOLD) {
      for (const [k, hits] of memoryStore) {
        if (hits[hits.length - 1] <= now - windowMs) memoryStore.delete(k);
      }
    }
    const hits = (memoryStore.get(key) ?? []).filter((t) => t > now - windowMs);
    hits.push(now);
    memoryStore.set(key, hits);
    return hits.length;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator ? keyGenerator(req) : `${prefix}:${req.ip}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    let count: number;

    try {
      const pipeline = redis.pipeline();
      // Remove requests outside the current window
      pipeline.zremrangebyscore(key, 0, windowStart);
      // Add current request
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      // Count requests in the window
      pipeline.zcard(key);
      // Set expiration to clear old data
      pipeline.expire(key, Math.ceil(windowMs / 1000));

      const results = await pipeline.exec();
      count = results?.[2]?.[1] as number;
      if (typeof count !== 'number') throw new Error('Invalid rate limiter response from Redis');
    } catch (error) {
      logger.warn(
        { err: error, prefix, failureMode, memoryFallback },
        'Rate limiter Redis unavailable, using fallback',
      );
      if (failureMode === 'open') {
        rateLimitFallbacksTotal.inc({ limiter: prefix, mode: 'open' });
        next();
        return;
      }
      if (!memoryFallback) {
        rateLimitFallbacksTotal.inc({ limiter: prefix, mode: 'closed' });
        const retryAfterSec = Math.min(Math.ceil(windowMs / 1000), MAX_UNAVAILABLE_RETRY_AFTER_SEC);
        res.setHeader('Retry-After', String(retryAfterSec));
        handleError(
          req,
          res as any,
          new AppError(
            'Service temporarily unavailable. Please try again later.',
            ErrorType.EXTERNAL_SERVICE_ERROR,
            503,
            true,
            { retryAfter: retryAfterSec },
          ),
        );
        return;
      }
      rateLimitFallbacksTotal.inc({ limiter: prefix, mode: 'memory' });
      count = memoryCount(key, now);
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

    if (count > max) {
      logger.warn({ ip: req.ip, path: req.originalUrl, prefix }, 'Rate limit exceeded');
      const retryAfterSec = Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      handleError(
        req,
        res as any,
        AppError.rateLimited('Too many requests. Please try again later.', {
          retryAfter: retryAfterSec,
        }),
      );
      return;
    }
    next();
  };
};

const API_WINDOW = parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10);
const API_MAX = parseInt(process.env.API_RATE_LIMIT_MAX || '100', 10);

const UPLOAD_WINDOW = parseInt(
  process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000),
  10,
);
const UPLOAD_MAX = parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || '10', 10);

const ADMIN_WINDOW = parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10);
const ADMIN_MAX = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || '30', 10);

export const apiRateLimiter = createSlidingWindowLimiter(API_WINDOW, API_MAX, 'api:rl');
export const uploadRateLimiter = createSlidingWindowLimiter(UPLOAD_WINDOW, UPLOAD_MAX, 'upload:rl');
export const adminRateLimiter = createSlidingWindowLimiter(ADMIN_WINDOW, ADMIN_MAX, 'admin:rl');

// Comment creation (issue #328): previously had no rate limiter at all,
// unlike other user-generated-content routes — an authenticated user could
// spam-post comments with no throttling. Keyed by the authenticated user
// (comment creation always requires auth), falling back to IP for safety
// if that's ever missing.
const COMMENT_WINDOW = parseInt(process.env.COMMENT_RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10);
const COMMENT_MAX = parseInt(process.env.COMMENT_RATE_LIMIT_MAX || '10', 10);

export const commentRateLimiter = createSlidingWindowLimiter(
  COMMENT_WINDOW,
  COMMENT_MAX,
  'comment:rl',
  (req) => {
    const userId = (req as any).user?.id;
    return userId ? `comment:rl:${userId}` : `comment:rl:${req.ip}`;
  },
);

// Song reports: at most 10 per user per hour to prevent report flooding.
export const reportRateLimiter = createSlidingWindowLimiter(
  60 * 60 * 1000,
  10,
  'report:rl',
  (req) => {
    const userId = (req as any).user?.id;
    return userId ? `report:rl:${userId}` : `report:rl:${req.ip}`;
  },
);

// AI Playlist Curation (Issue #275): Rate limit per user for AI prompt curation
const AI_CURATION_WINDOW = parseInt(
  process.env.AI_CURATION_RATE_LIMIT_WINDOW_MS || String(60 * 1000),
  10,
);
const AI_CURATION_MAX = parseInt(process.env.AI_CURATION_RATE_LIMIT_MAX || '10', 10);

export const aiPlaylistCurationRateLimiter = createSlidingWindowLimiter(
  AI_CURATION_WINDOW,
  AI_CURATION_MAX,
  'ai:curation:rl',
  (req) => {
    const userId = (req as any).user?.id;
    return userId ? `ai:curation:rl:${userId}` : `ai:curation:rl:${req.ip}`;
  },
);

export const createTieredApiRateLimiter = (
  tierLimits: Record<string, { windowMs: number; max: number }>,
  defaultTier: string = 'standard',
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiKey = (req as any).apiKey;
    const tier =
      apiKey?.rateLimitTier && tierLimits[apiKey.rateLimitTier]
        ? apiKey.rateLimitTier
        : defaultTier;
    const config = tierLimits[tier] ||
      tierLimits[defaultTier] || { windowMs: API_WINDOW, max: API_MAX };

    const limiter = createSlidingWindowLimiter(
      config.windowMs,
      config.max,
      `api:tier:${tier}`,
      (r) => (apiKey ? `api:rl:key:${apiKey.id}` : `${'api:rl'}:${r.ip}`),
    );
    return limiter(req, res, next);
  };
};
