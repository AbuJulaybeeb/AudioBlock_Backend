jest.mock('../../config/db', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

function setup() {
  jest.resetModules();
  const mod = require('../gracefulShutdown') as typeof import('../gracefulShutdown');
  const channel = {
    cancel: jest.fn().mockResolvedValue({}),
    nack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const closeConnection = jest.fn().mockResolvedValue(undefined);
  const worker = mod.registerWorkerQueue(channel, closeConnection);
  worker.setConsumerTag('consumer');
  return { ...mod, channel, closeConnection, worker };
}
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SHUTDOWN_DRAIN_TIMEOUT_MS;
});
it('cancels delivery and waits for the handler before closing resources', async () => {
  const { channel, closeConnection, worker, drainWorkerQueues } = setup();
  let finish!: () => void;
  let active = false;
  const task = worker.handle({} as any, async (isActive) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    active = isActive();
  });
  await Promise.resolve();
  const draining = drainWorkerQueues();
  expect(channel.cancel).toHaveBeenCalledWith('consumer');
  expect(channel.close).not.toHaveBeenCalled();
  const unexpected = jest.fn();
  const late = {} as any;
  await worker.handle(late, unexpected);
  expect(unexpected).not.toHaveBeenCalled();
  expect(channel.nack).toHaveBeenCalledWith(late, false, true);
  finish();
  await task;
  await draining;
  expect(active).toBe(true);
  expect(channel.close).toHaveBeenCalledTimes(1);
  expect(closeConnection).toHaveBeenCalledTimes(1);
  await drainWorkerQueues();
  expect(channel.close).toHaveBeenCalledTimes(1);
});
it('requeues timed-out deliveries and prevents late acknowledgements', async () => {
  jest.useFakeTimers();
  process.env.SHUTDOWN_DRAIN_TIMEOUT_MS = '20';
  const { worker, channel, drainWorkerQueues } = setup();
  let finish!: () => void;
  const ack = jest.fn();
  const msg = {} as any;
  const task = worker.handle(msg, async (isActive) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (isActive()) ack();
  });
  await Promise.resolve();
  const draining = drainWorkerQueues();
  await jest.advanceTimersByTimeAsync(20);
  await draining;
  expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  finish();
  await task;
  expect(ack).not.toHaveBeenCalled();
});
it('closes resources after rejected handlers and failed cancellation', async () => {
  const { worker, channel, closeConnection, drainWorkerQueues } = setup();
  channel.cancel.mockRejectedValue(new Error('closed'));
  await expect(
    worker.handle({} as any, async () => {
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  await drainWorkerQueues();
  expect(channel.close).toHaveBeenCalled();
  expect(closeConnection).toHaveBeenCalled();
});

it('cancels a consumer whose consume response arrives after draining starts', async () => {
  const { registerWorkerQueue, drainWorkerQueues, channel } = setup();
  const late = registerWorkerQueue(channel, async () => {});
  const draining = drainWorkerQueues();
  await late.setConsumerTag('late');
  await draining;
  expect(channel.cancel).toHaveBeenCalledWith('late');
});
