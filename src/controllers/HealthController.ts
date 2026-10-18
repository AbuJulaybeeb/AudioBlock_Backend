/**
 * Health check endpoints for liveness/readiness probes (Issue #146)
 * ──────────────────────────────────────────────────────────────────
 * Container orchestrators (Kubernetes, a load balancer) need cheap,
 * predictable endpoints to manage the application lifecycle:
 *
 *   GET /health/live      – is the process running? Never checks dependencies,
 *                           so a slow DB/Redis never causes a needless restart.
 *   GET /health/ready     – are DB / Redis (if configured) / Pinata reachable?
 *                           503 when any required dependency is down, so the
 *                           load balancer stops routing traffic here.
 *   GET /health/detailed  – full report (admin only): every dependency's
 *                           status + latency, DB pool stats, memory, uptime.
 *
 * Every dependency check is capped at HEALTH_CHECK_TIMEOUT_MS so the overall
 * response always completes well within the 5s acceptance budget, and a
 * failing dependency is logged at `warn` (not `error`) since a degraded
 * readiness probe is an expected, recoverable condition rather than a bug.
 */
import { Request, Response } from 'express';
import axios from 'axios';
import AppDataSource from '../config/db';
import redis from '../config/redis';
import logger from '../config/logger';
import { getPoolStats } from '../services/DbPoolMonitor';
import { getWorkerHealthStatus, WorkerHealthStatus } from '../workers/SongProcessorWorker';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

export type DependencyState = 'ok' | 'error' | 'not_configured';

export interface DependencyStatus {
  status: DependencyState;
  latencyMs?: number;
  message?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unhealthy';
  timestamp: string;
  uptime: number;
  dependencies: Record<string, DependencyStatus>;
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function checkDatabase(): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    await withTimeout(AppDataSource.query('SELECT 1'), HEALTH_CHECK_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    logger.warn({ err }, 'Health check: database dependency unavailable');
    return { status: 'error', latencyMs: Date.now() - start, message };
  }
}

async function checkRedis(): Promise<DependencyStatus> {
  if (!process.env.REDIS_HOST) {
    return { status: 'not_configured' };
  }

  const start = Date.now();
  try {
    await withTimeout(redis.ping(), HEALTH_CHECK_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Redis error';
    logger.warn({ err }, 'Health check: Redis dependency unavailable');
    return { status: 'error', latencyMs: Date.now() - start, message };
  }
}

async function checkPinata(): Promise<DependencyStatus> {
  const gateway = process.env.PINATA_GATEWAY;
  if (!gateway || !process.env.PINATA_JWT) {
    return { status: 'not_configured' };
  }

  const start = Date.now();
  try {
    const url = gateway.startsWith('http') ? gateway : `https://${gateway}`;
    // Any HTTP response (even 4xx) proves the gateway is reachable; only
    // network-level failures/timeouts indicate an unhealthy dependency.
    await withTimeout(
      axios.get(url, { timeout: HEALTH_CHECK_TIMEOUT_MS, validateStatus: () => true }),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Pinata error';
    logger.warn({ err }, 'Health check: Pinata dependency unreachable');
    return { status: 'error', latencyMs: Date.now() - start, message };
  }
}

async function checkDependencies(): Promise<Record<string, DependencyStatus>> {
  const [database, redisStatus, pinata] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkPinata(),
  ]);

  return { database, redis: redisStatus, pinata };
}

function isHealthy(dependencies: Record<string, DependencyStatus>): boolean {
  return Object.values(dependencies).every((dep) => dep.status !== 'error');
}

export class HealthController {
  /** Liveness: the process is up and handling requests. No dependency checks. */
  static live = (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  };

  /** Readiness: safe to receive traffic only when dependencies are reachable. */
  static ready = async (_req: Request, res: Response) => {
    const dependencies = await checkDependencies();
    const healthy = isHealthy(dependencies);
    const report: ReadinessReport = {
      status: healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies,
    };

    res.status(healthy ? 200 : 503).json(report);
  };

  /** Worker liveness and stale consumer health check (Issue #356) */
  static worker = async (req: Request, res: Response) => {
    const thresholdParam = req.query.staleThresholdMs
      ? parseInt(req.query.staleThresholdMs as string, 10)
      : undefined;

    const workerStatus: WorkerHealthStatus = await getWorkerHealthStatus(thresholdParam);
    const healthy = workerStatus.status === 'ok' || workerStatus.status === 'not_configured';

    res.status(healthy ? 200 : 503).json(workerStatus);
  };

  /** Full health report (admin only): dependencies + pool stats + process info + worker. */
  static detailed = async (_req: Request, res: Response) => {
    const [dependencies, worker] = await Promise.all([
      checkDependencies(),
      getWorkerHealthStatus(),
    ]);
    const healthy = isHealthy(dependencies);

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies,
      worker,
      dbPool: getPoolStats(AppDataSource),
      memory: process.memoryUsage(),
      env: process.env.NODE_ENV || 'development',
    });
  };
}
