import 'reflect-metadata';
import { Request, Response } from 'express';
import { HealthController } from '../controllers/HealthController';
import {
  getWorkerHealthStatus,
  setWorkerHealthStateForTests,
  resetWorkerHealthForTests,
  startSongWorker,
} from '../workers/SongProcessorWorker';
import * as rabbitmq from '../config/rabbitmq';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    getRepository: jest.fn().mockReturnValue({ findOne: jest.fn() }),
  },
}));

jest.mock('../config/redis', () => ({
  __esModule: true,
  default: { ping: jest.fn(), get: jest.fn(), set: jest.fn(), on: jest.fn() },
}));

describe('Worker Health Check (Issue #356)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkerHealthForTests();
    process.env = { ...originalEnv, RABBITMQ_URL: 'amqp://localhost:5672' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('song consumer prefetch', () => {
    it.each([undefined, '2'])('sets bounded prefetch before consuming (%s)', async (value) => {
      if (value === undefined) delete process.env.WORKER_PREFETCH;
      else process.env.WORKER_PREFETCH = value;
      const channel = {
        prefetch: jest.fn().mockResolvedValue(undefined),
        assertQueue: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockResolvedValue({ consumerTag: 'test-consumer' }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(channel as any);
      expect(await startSongWorker()).toBe(true);
      expect(channel.prefetch).toHaveBeenCalledWith(value === undefined ? 1 : 2);
      expect(channel.prefetch.mock.invocationCallOrder[0]).toBeLessThan(
        channel.consume.mock.invocationCallOrder[0],
      );
    });

    it.each(['0', '-1', '1.5', 'NaN', 'Infinity'])('refuses unsafe prefetch %s', async (value) => {
      process.env.WORKER_PREFETCH = value;
      const channel = { prefetch: jest.fn(), consume: jest.fn() };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(channel as any);
      expect(await startSongWorker()).toBe(false);
      expect(channel.consume).not.toHaveBeenCalled();
      expect(channel.prefetch).not.toHaveBeenCalled();
    });
  });

  describe('getWorkerHealthStatus unit logic', () => {
    it('returns not_configured when RABBITMQ_URL is missing', async () => {
      delete process.env.RABBITMQ_URL;

      const status = await getWorkerHealthStatus();
      expect(status.status).toBe('not_configured');
      expect(status.connected).toBe(false);
      expect(status.isStale).toBe(false);
    });

    it('returns error when channel is not available', async () => {
      jest.spyOn(rabbitmq, 'getChannel').mockImplementation(() => {
        throw new Error('Channel not initialized');
      });

      const status = await getWorkerHealthStatus();
      expect(status.status).toBe('error');
      expect(status.connected).toBe(false);
      expect(status.message).toContain('disconnected');
    });

    it('returns ok when consumer is active and no jobs pending', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 0,
          consumerCount: 1,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      setWorkerHealthStateForTests({
        startedAt: new Date(Date.now() - 60000),
        isConsuming: true,
        consumerTag: 'amq.ctag-test123',
        lastJobProcessedAt: new Date(Date.now() - 30000),
        jobsProcessedCount: 5,
        jobsFailedCount: 0,
      });

      const status = await getWorkerHealthStatus();
      expect(status.status).toBe('ok');
      expect(status.connected).toBe(true);
      expect(status.isConsuming).toBe(true);
      expect(status.activeConsumersCount).toBe(1);
      expect(status.pendingJobsCount).toBe(0);
      expect(status.isStale).toBe(false);
      expect(status.jobsProcessedCount).toBe(5);
    });

    it('returns error when active consumer count is zero', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 3,
          consumerCount: 0,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      const status = await getWorkerHealthStatus();
      expect(status.status).toBe('error');
      expect(status.activeConsumersCount).toBe(0);
      expect(status.isStale).toBe(true);
      expect(status.message).toContain('No active consumers');
    });

    it('detects a stale consumer when jobs are pending and none processed within threshold', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 10,
          consumerCount: 1,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      // Simulate last job processed 15 minutes ago (threshold is 5 mins / 300,000 ms)
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      setWorkerHealthStateForTests({
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        isConsuming: true,
        consumerTag: 'amq.ctag-stale-test',
        lastJobProcessedAt: fifteenMinutesAgo,
        jobsProcessedCount: 20,
      });

      const status = await getWorkerHealthStatus(300000);
      expect(status.status).toBe('degraded');
      expect(status.isStale).toBe(true);
      expect(status.pendingJobsCount).toBe(10);
      expect(status.message).toContain('Stale consumer: 10 jobs pending');
    });

    it('does NOT mark stale if pending jobs exist but last job was processed recently', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 2,
          consumerCount: 1,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      // Last job processed 1 minute ago (within 5 min threshold)
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      setWorkerHealthStateForTests({
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        isConsuming: true,
        consumerTag: 'amq.ctag-active-test',
        lastJobProcessedAt: oneMinuteAgo,
        jobsProcessedCount: 25,
      });

      const status = await getWorkerHealthStatus(300000);
      expect(status.status).toBe('ok');
      expect(status.isStale).toBe(false);
    });
  });

  describe('HealthController.worker HTTP Handler', () => {
    it('returns 200 with worker status when healthy', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 0,
          consumerCount: 1,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      setWorkerHealthStateForTests({
        startedAt: new Date(),
        isConsuming: true,
        consumerTag: 'tag-1',
      });

      const req = { query: {} } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock } as unknown as Response;

      await HealthController.worker(req, res);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          connected: true,
          isConsuming: true,
          isStale: false,
        }),
      );
    });

    it('returns 503 when worker is stale or degraded', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 5,
          consumerCount: 1,
        }),
      };
      jest.spyOn(rabbitmq, 'getChannel').mockReturnValue(mockChannel as any);

      // 10 minutes ago
      setWorkerHealthStateForTests({
        startedAt: new Date(Date.now() - 3600000),
        isConsuming: true,
        lastJobProcessedAt: new Date(Date.now() - 600000),
      });

      const req = { query: { staleThresholdMs: '300000' } } as unknown as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock } as unknown as Response;

      await HealthController.worker(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'degraded',
          isStale: true,
        }),
      );
    });
  });
});
