import { Router } from 'express';
import logger from '../config/logger';
import { getMetrics, getMetricsContentType, collectQueueDepth } from '../services/MetricsService';
import { getRawChannel, MAIN_QUEUE } from '../config/rabbitmq';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const rawChannel = getRawChannel();
    if (rawChannel) {
      try {
        await collectQueueDepth(rawChannel, MAIN_QUEUE);
      } catch (queueErr) {
        logger.warn({ err: queueErr }, 'Failed to collect RabbitMQ queue depth metrics');
      }
    }
    res.set('Content-Type', await getMetricsContentType());
    res.status(200).send(await getMetrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to render Prometheus metrics');
    res.status(500).type('text/plain').send('Metrics temporarily unavailable');
  }
});

export default router;
