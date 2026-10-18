import { createMockRequest, createMockResponse } from '../../../tests/helpers';

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    pipeline: () => ({
      zremrangebyscore: jest.fn(),
      zadd: jest.fn(),
      zcard: jest.fn(),
      expire: jest.fn(),
      exec: () => Promise.reject(new Error('Redis connection refused')),
    }),
  },
}));

import { createSlidingWindowLimiter } from '../rateLimiter';
import { authRateLimiter, nonceRateLimiter, passwordResetRateLimiter } from '../authRateLimiter';
import { getMetrics } from '../../services/MetricsService';

function run(limiter: ReturnType<typeof createSlidingWindowLimiter>) {
  const req = createMockRequest({ body: { email: 'a@example.com' } });
  req.ip = '1.2.3.4';
  const res: any = createMockResponse();
  const next = jest.fn();
  return limiter(req, res, next).then(() => ({ res, next }));
}

describe('rate limiter behavior when Redis is down', () => {
  it('fails open by default so general endpoints keep working', async () => {
    const { res, next } = await run(createSlidingWindowLimiter(60_000, 1, 'general:rl'));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fails closed with 503 and Retry-After in closed mode', async () => {
    const limiter = createSlidingWindowLimiter(60_000, 1, 'closed:rl', undefined, {
      failureMode: 'closed',
    });
    const { res, next } = await run(limiter);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('enforces per-instance limits with the in-memory fallback', async () => {
    const limiter = createSlidingWindowLimiter(60_000, 2, 'memory:rl', undefined, {
      failureMode: 'closed',
      memoryFallback: true,
    });

    const first = await run(limiter);
    const second = await run(limiter);
    const third = await run(limiter);

    expect(first.next).toHaveBeenCalledTimes(1);
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(third.next).not.toHaveBeenCalled();
    expect(third.res.status).toHaveBeenCalledWith(429);
  });

  it.each([
    ['auth', authRateLimiter],
    ['nonce', nonceRateLimiter],
    ['password reset', passwordResetRateLimiter],
  ])('does not leave the %s limiter unlimited', async (_name, limiter) => {
    const { res, next } = await run(limiter);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('records the fallback in the rate_limit_fallbacks_total metric', async () => {
    await run(createSlidingWindowLimiter(60_000, 1, 'metric:rl'));

    const metrics = await getMetrics();
    expect(metrics).toContain('rate_limit_fallbacks_total{limiter="metric:rl",mode="open"} 1');
  });
});
