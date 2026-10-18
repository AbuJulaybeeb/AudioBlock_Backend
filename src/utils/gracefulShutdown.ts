import type { Server } from 'http';
import type { Channel, ConsumeMessage } from 'amqplib';
import AppDataSource from '../config/db';
import logger from '../config/logger';
import redis from '../config/redis';

interface ShutdownHook {
  name: string;
  close: () => Promise<void>;
}

interface ShutdownState {
  shuttingDown: boolean;
  server: Server | null;
  hooks: ShutdownHook[];
}

const state: ShutdownState = {
  shuttingDown: false,
  server: null,
  hooks: [],
};

export function isShuttingDown(): boolean {
  return state.shuttingDown;
}

export function registerServer(server: Server): void {
  state.server = server;
}

export function registerShutdownHook(name: string, close: () => Promise<void>): void {
  state.hooks.push({ name, close });
}

async function performShutdown(signal: string): Promise<void> {
  if (state.shuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
    return;
  }

  state.shuttingDown = true;
  logger.warn({ signal }, `Received ${signal} — starting graceful shutdown`);

  const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000);
  let forceExit = false;

  const forceTimer = setTimeout(() => {
    forceExit = true;
    logger.error('Shutdown timed out after 30s — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  const draining = drainWorkerQueues();

  try {
    if (state.server) {
      logger.info('Stopping HTTP server — no longer accepting new requests');
      await new Promise<void>((resolve) => {
        state.server!.close(() => resolve());
      });
      logger.info('HTTP server closed');
    }
  } catch (err) {
    logger.error({ err }, 'Error closing HTTP server');
  }

  await draining;

  for (const hook of state.hooks) {
    try {
      logger.info(`Running shutdown hook: ${hook.name}`);
      await hook.close();
      logger.info(`Shutdown hook complete: ${hook.name}`);
    } catch (err) {
      logger.error({ err, hook: hook.name }, 'Shutdown hook failed');
    }
  }

  if (!forceExit) {
    clearTimeout(forceTimer);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  }
}

function isFatalRejection(reason: unknown): boolean {
  const fatalNames = [
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
  ];
  return reason instanceof Error && fatalNames.includes(reason.name);
}

export function attachProcessHandlers(): void {
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logger.error({ reason, promise: String(promise) }, 'Unhandled promise rejection');
    if (isFatalRejection(reason)) {
      logger.error({ reason }, 'Fatal unhandled rejection detected — initiating graceful shutdown');
      performShutdown('unhandledRejection');
    }
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error({ err: error }, 'Uncaught exception — initiating graceful shutdown');
    performShutdown('uncaughtException');
  });

  process.on('SIGTERM', () => {
    performShutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    performShutdown('SIGINT');
  });
}

export async function closeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
    logger.info('Database connection pool closed');
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error({ err }, 'Error closing Redis connection');
  }
}

interface WorkerRegistration {
  channel: Pick<Channel, 'cancel' | 'nack' | 'close'>;
  consumerTag?: string;
  closeConnection: () => Promise<void>;
  pending: Map<ConsumeMessage, { promise: Promise<void>; active: boolean }>;
  stopping: boolean;
}

const workers = new Set<WorkerRegistration>();
let drainPromise: Promise<void> | undefined;

export function registerWorkerQueue(
  channel: WorkerRegistration['channel'],
  closeConnection: () => Promise<void>,
) {
  if (state.shuttingDown || drainPromise) throw new Error('Cannot start worker during shutdown');
  const worker: WorkerRegistration = {
    channel,
    closeConnection,
    pending: new Map(),
    stopping: false,
  };
  workers.add(worker);
  return {
    async setConsumerTag(tag: string): Promise<void> {
      worker.consumerTag = tag;
      if (worker.stopping) {
        try {
          await channel.cancel(tag);
        } catch (err) {
          logger.error({ err }, 'Failed to cancel late queue consumer');
        }
      }
    },
    async handle(
      msg: ConsumeMessage,
      handler: (isActive: () => boolean) => Promise<void>,
    ): Promise<void> {
      if (worker.stopping || state.shuttingDown) {
        channel.nack(msg, false, true);
        return;
      }
      const entry = { promise: Promise.resolve(), active: true };
      worker.pending.set(msg, entry);
      // Defer invocation so the promise is registered before the handler runs.
      entry.promise = Promise.resolve()
        .then(() => handler(() => entry.active))
        .finally(() => {
          entry.active = false;
          worker.pending.delete(msg);
        });
      await entry.promise;
    },
  };
}

export function drainWorkerQueues(): Promise<void> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    const configured = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 25000);
    const timeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : 25000;
    const registrations = [...workers];
    registrations.forEach((worker) => {
      worker.stopping = true;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all(
            registrations.map(async (worker) => {
              if (worker.consumerTag) {
                try {
                  await worker.channel.cancel(worker.consumerTag);
                } catch (err) {
                  logger.error({ err }, 'Failed to cancel queue consumer');
                }
              }
            }),
          );
          await Promise.allSettled(
            registrations.flatMap((worker) =>
              [...worker.pending.values()].map((entry) => entry.promise),
            ),
          );
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      for (const worker of registrations) {
        for (const [msg, entry] of worker.pending) {
          entry.active = false;
          try {
            worker.channel.nack(msg, false, true);
          } catch (err) {
            logger.error(
              { err },
              'Failed to requeue unfinished message; connection close will requeue',
            );
          }
        }
      }
      await Promise.allSettled(
        [...new Set(registrations.map((worker) => worker.channel))].map(async (channel) =>
          channel.close(),
        ),
      );
      await Promise.allSettled(
        [...new Set(registrations.map((worker) => worker.closeConnection))].map(async (close) =>
          close(),
        ),
      );
      registrations.forEach((worker) => workers.delete(worker));
    }
  })();
  return drainPromise;
}
