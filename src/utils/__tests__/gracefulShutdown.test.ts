/**
 * Tests for gracefulShutdown utilities (#832).
 *
 * The module stores state (hooks[], server, shuttingDown) at the module level,
 * so each test suite resets the module registry to get a clean slate.
 */

// --- dependency mocks declared before any require/import ---

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: {
    isInitialized: false,
    destroy: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { quit: jest.fn() },
}));

jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ─── helpers ────────────────────────────────────────────────────────────────

/** Load a fresh copy of gracefulShutdown (resets module-level state). */
function freshModule() {
  jest.resetModules();
  // Re-apply mocks for the freshly loaded modules
  jest.mock('../../config/db', () => ({
    __esModule: true,
    default: {
      isInitialized: false,
      destroy: jest.fn().mockResolvedValue(undefined),
    },
  }));
  jest.mock('../../config/redis', () => ({
    __esModule: true,
    default: { quit: jest.fn() },
  }));
  jest.mock('../../config/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../gracefulShutdown') as typeof import('../gracefulShutdown');
}

// ─── closeRedis ──────────────────────────────────────────────────────────────

describe('closeRedis', () => {
  it('calls redis.quit() and resolves normally', async () => {
    const mod = freshModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const redis = require('../../config/redis').default;
    (redis.quit as jest.Mock).mockResolvedValue('OK');

    await expect(mod.closeRedis()).resolves.toBeUndefined();
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when redis.quit() rejects — error is swallowed', async () => {
    const mod = freshModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const redis = require('../../config/redis').default;
    (redis.quit as jest.Mock).mockRejectedValue(new Error('connection lost'));

    await expect(mod.closeRedis()).resolves.toBeUndefined();
  });
});

// ─── closeDatabase ───────────────────────────────────────────────────────────

describe('closeDatabase', () => {
  it('skips destroy when the pool is not initialised', async () => {
    const mod = freshModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AppDataSource = require('../../config/db').default;
    AppDataSource.isInitialized = false;

    await mod.closeDatabase();

    expect(AppDataSource.destroy).not.toHaveBeenCalled();
  });

  it('calls destroy when the pool is initialised', async () => {
    const mod = freshModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AppDataSource = require('../../config/db').default;
    AppDataSource.isInitialized = true;
    (AppDataSource.destroy as jest.Mock).mockResolvedValue(undefined);

    await mod.closeDatabase();

    expect(AppDataSource.destroy).toHaveBeenCalledTimes(1);
  });
});

// ─── registerShutdownHook + isShuttingDown ────────────────────────────────────

describe('registerShutdownHook and isShuttingDown', () => {
  it('isShuttingDown() returns false before any shutdown begins', () => {
    const mod = freshModule();
    expect(mod.isShuttingDown()).toBe(false);
  });

  it('registers hooks that run in registration order during shutdown', async () => {
    jest.useFakeTimers();
    const mod = freshModule();

    const order: number[] = [];
    mod.registerShutdownHook('hook-1', async () => { order.push(1); });
    mod.registerShutdownHook('hook-2', async () => { order.push(2); });
    mod.registerShutdownHook('hook-3', async () => { order.push(3); });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Trigger shutdown via SIGTERM; the handler is attached by attachProcessHandlers
    mod.attachProcessHandlers();
    process.emit('SIGTERM');

    // Let the async shutdown chain run
    await jest.runAllTimersAsync();

    expect(order).toEqual([1, 2, 3]);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    jest.useRealTimers();
  });
});

// ─── shutdown hook failure isolation ─────────────────────────────────────────

describe('hook failure isolation', () => {
  it('continues running remaining hooks even when one throws', async () => {
    jest.useFakeTimers();
    const mod = freshModule();

    const ranHook2 = jest.fn();
    mod.registerShutdownHook('bad-hook', async () => {
      throw new Error('hook exploded');
    });
    mod.registerShutdownHook('good-hook', ranHook2);

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    mod.attachProcessHandlers();
    process.emit('SIGTERM');
    await jest.runAllTimersAsync();

    expect(ranHook2).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    jest.useRealTimers();
  });
});

// ─── process.exit codes ──────────────────────────────────────────────────────

describe('process exit codes', () => {
  it('exits with code 0 after a clean shutdown', async () => {
    jest.useFakeTimers();
    const mod = freshModule();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    mod.attachProcessHandlers();
    process.emit('SIGTERM');
    await jest.runAllTimersAsync();

    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it('exits with code 1 when the shutdown timeout fires', async () => {
    jest.useFakeTimers();
    const mod = freshModule();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // A hook that never resolves simulates a stalled shutdown
    mod.registerShutdownHook('hanging', () => new Promise(() => {}));

    process.env.SHUTDOWN_TIMEOUT_MS = '100';
    mod.attachProcessHandlers();
    process.emit('SIGTERM');

    // Advance past the timeout but NOT past runAllTimers so the hook stays hung
    await jest.advanceTimersByTimeAsync(200);

    expect(exitSpy).toHaveBeenCalledWith(1);

    delete process.env.SHUTDOWN_TIMEOUT_MS;
    exitSpy.mockRestore();
    jest.useRealTimers();
  });
});
