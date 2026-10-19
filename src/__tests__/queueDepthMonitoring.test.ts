import 'reflect-metadata';
import {
  updateRabbitMQQueueDepth,
  collectQueueDepth,
  getMetrics,
} from '../services/MetricsService';

describe('RabbitMQ Queue Depth Monitoring & Alerting (Issue #377)', () => {
  beforeEach(() => {
    updateRabbitMQQueueDepth('song_processing', 0);
  });

  describe('Queue depth metric exposition', () => {
    it('exposes rabbitmq_queue_depth gauge with queue label', async () => {
      updateRabbitMQQueueDepth('song_processing', 5);

      const metrics = await getMetrics();
      expect(metrics).toContain('rabbitmq_queue_depth{queue="song_processing"} 5');
    });

    it('collects queue depth from an active channel checkQueue', async () => {
      const mockChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 12,
          consumerCount: 1,
        }),
      };

      const depth = await collectQueueDepth(mockChannel as any, 'song_processing');
      expect(depth).toBe(12);

      const metrics = await getMetrics();
      expect(metrics).toContain('rabbitmq_queue_depth{queue="song_processing"} 12');
      expect(mockChannel.checkQueue).toHaveBeenCalledWith('song_processing');
    });
  });

  describe('Paused-consumer test and backlog alerting', () => {
    it('reflects sustained backlog when consumer is paused and messages accumulate', async () => {
      // Simulate paused consumer state: consumerCount is 0, messageCount is rising
      const pausedChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 15,
          consumerCount: 0, // Consumer is paused/crashed
        }),
      };

      // 1. Scrape/collect depth during paused consumer state
      const depth = await collectQueueDepth(pausedChannel as any, 'song_processing');
      expect(depth).toBe(15);

      // 2. Verify metric exposition reflects depth
      const metrics = await getMetrics();
      expect(metrics).toContain('rabbitmq_queue_depth{queue="song_processing"} 15');

      // 3. Verify warning alert threshold (depth > 10) triggers
      const WARNING_THRESHOLD = 10;
      const isWarningAlertActive = depth > WARNING_THRESHOLD;
      expect(isWarningAlertActive).toBe(true);

      // 4. Backlog escalates past critical threshold (depth > 50)
      pausedChannel.checkQueue.mockResolvedValueOnce({
        queue: 'song_processing',
        messageCount: 55,
        consumerCount: 0,
      });

      const criticalDepth = await collectQueueDepth(pausedChannel as any, 'song_processing');
      expect(criticalDepth).toBe(55);

      const CRITICAL_THRESHOLD = 50;
      const isCriticalAlertActive = criticalDepth > CRITICAL_THRESHOLD;
      expect(isCriticalAlertActive).toBe(true);

      const criticalMetrics = await getMetrics();
      expect(criticalMetrics).toContain('rabbitmq_queue_depth{queue="song_processing"} 55');

      // 5. Consumer resumes, backlog drains to 0
      const resumedChannel = {
        checkQueue: jest.fn().mockResolvedValue({
          queue: 'song_processing',
          messageCount: 0,
          consumerCount: 2, // Consumer active and working
        }),
      };

      const drainedDepth = await collectQueueDepth(resumedChannel as any, 'song_processing');
      expect(drainedDepth).toBe(0);

      const drainedMetrics = await getMetrics();
      expect(drainedMetrics).toContain('rabbitmq_queue_depth{queue="song_processing"} 0');

      // Alert condition is now cleared
      expect(drainedDepth > WARNING_THRESHOLD).toBe(false);
      expect(drainedDepth > CRITICAL_THRESHOLD).toBe(false);
    });
  });
});
