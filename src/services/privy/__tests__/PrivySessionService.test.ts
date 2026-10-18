jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('../../../config/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
import { PrivySessionService } from '../PrivySessionService';

function sharedStore() {
  const values = new Map<string, { value: string; expires?: number }>();
  return {
    set: jest.fn(async (key: string, value: string, _mode?: string, ttl?: number) => {
      values.set(key, { value, expires: ttl ? Date.now() + ttl * 1000 : undefined });
      return 'OK';
    }),
    get: jest.fn(async (key: string) => {
      const entry = values.get(key);
      return entry && (!entry.expires || entry.expires > Date.now()) ? entry.value : null;
    }),
  };
}
afterEach(() => {
  jest.useRealTimers();
  delete process.env.PRIVY_REVOCATION_FAILURE_MODE;
});
it('shares revocations across instances and restarts, and expires keys', async () => {
  jest.useFakeTimers();
  const store = sharedStore();
  const first = new PrivySessionService(store as any);
  await first.revokeSession('sid', Date.now() / 1000 + 60);
  expect(store.set).toHaveBeenCalledWith('privy:revoked:sid', '1', 'EX', 60);
  expect(await new PrivySessionService(store as any).isSessionRevoked('sid')).toBe(true);
  jest.advanceTimersByTime(61000);
  expect(await new PrivySessionService(store as any).isSessionRevoked('sid')).toBe(false);
});
it('revokes all earlier user tokens but accepts newer tokens', async () => {
  const store = sharedStore();
  const first = new PrivySessionService(store as any);
  const now = Date.now() / 1000;
  await first.revokeAllForUser('user');
  const second = new PrivySessionService(store as any);
  expect(await second.isSessionRevoked('unseen', 'user', now - 10)).toBe(true);
  expect(await second.isSessionRevoked('new', 'user', now + 10)).toBe(false);
  expect(await second.isSessionRevoked('other', 'other', now - 10)).toBe(false);
});
it('defaults to fail closed and supports explicit fail open; writes still fail', async () => {
  const store = {
    get: jest.fn().mockRejectedValue(new Error('offline')),
    set: jest.fn().mockRejectedValue(new Error('offline')),
  };
  const service = new PrivySessionService(store as any);
  expect(await service.isSessionRevoked('sid')).toBe(true);
  process.env.PRIVY_REVOCATION_FAILURE_MODE = 'open';
  expect(await service.isSessionRevoked('sid')).toBe(false);
  await expect(service.revokeAllForUser('user')).rejects.toThrow('offline');
});
it('does not write expired session revocations', async () => {
  const store = sharedStore();
  await new PrivySessionService(store as any).revokeSession('expired', Date.now() / 1000 - 1);
  expect(store.set).not.toHaveBeenCalled();
});

it('bounds an unresponsive Redis lookup', async () => {
  jest.useFakeTimers();
  const service = new PrivySessionService({
    get: () => new Promise(() => {}),
    set: jest.fn(),
  } as any);
  const lookup = service.isSessionRevoked('sid');
  await jest.advanceTimersByTimeAsync(2000);
  expect(await lookup).toBe(true);
});
