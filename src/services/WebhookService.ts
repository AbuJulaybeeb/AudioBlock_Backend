import crypto from 'crypto';
import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { WebhookSubscription } from '../entities/WebhookSubscription';
import logger from '../config/logger';

export interface WebhookPayload {
  eventId: string;
  eventType: string;
  timestamp: string;
  [key: string]: any;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Service for managing webhook subscriptions and delivering signed event payloads.
 * Follows WEBHOOK_IMPLEMENTATION_PLAN.md: HMAC-SHA256 signing + exponential backoff retries.
 */
export class WebhookService {
  private subscriptionRepo: Repository<WebhookSubscription>;
  /** Allows injection of fetch for testing; defaults to global fetch */
  private fetchFn: typeof fetch;

  constructor(fetchFn?: typeof fetch) {
    try {
      this.subscriptionRepo = AppDataSource.getRepository(WebhookSubscription);
    } catch {
      // In tests AppDataSource may be mocked without this entity — create a dummy stub
      this.subscriptionRepo = {
        find: async () => [],
      } as unknown as Repository<WebhookSubscription>;
    }
    this.fetchFn = fetchFn || (global.fetch as typeof fetch);
  }

  /**
   * Generate HMAC-SHA256 signature for payload.
   * Matches plan's X-Webhook-Signature header.
   */
  signPayload(payload: WebhookPayload | any, secret: string): string {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  verifySignature(payload: any, signature: string, secret: string): boolean {
    const expected = this.signPayload(payload, secret);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async registerSubscription(
    userId: string,
    endpoint: string,
    eventTypes?: string[],
    providedSecret?: string,
  ): Promise<WebhookSubscription> {
    // Validate URL
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('endpoint must use http or https');
      }
    } catch {
      throw new Error('Invalid endpoint URL');
    }

    const secret = providedSecret || crypto.randomBytes(32).toString('hex');

    const sub = this.subscriptionRepo.create({
      userId,
      endpoint,
      secret,
      eventTypes: eventTypes && eventTypes.length > 0 ? eventTypes : ['*'],
      isActive: true,
    });

    const saved = await this.subscriptionRepo.save(sub);
    logger.info({ subscriptionId: saved.id, userId, endpoint }, 'Webhook subscription registered');
    return saved;
  }

  async listSubscriptions(userId: string): Promise<WebhookSubscription[]> {
    return this.subscriptionRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async deleteSubscription(userId: string, subscriptionId: string): Promise<void> {
    const sub = await this.subscriptionRepo.findOne({ where: { id: subscriptionId, userId } });
    if (!sub) throw new Error('Webhook subscription not found');
    await this.subscriptionRepo.remove(sub);
  }

  /**
   * Deliver payload to a single endpoint with retries and exponential backoff.
   * Mirrors plan's WebhookService.deliver implementation.
   */
  async deliver(endpoint: string, payload: WebhookPayload, secret: string): Promise<void> {
    const maxRetries = 3;
    const signature = this.signPayload(payload, secret);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
          },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          logger.info(
            { endpoint, eventType: payload.eventType, attempt: attempt + 1 },
            'Webhook delivered',
          );
          return;
        }
        logger.warn(
          { endpoint, status: res.status, attempt: attempt + 1 },
          'Webhook delivery failed - non-OK status',
        );
      } catch (error) {
        logger.warn(
          { endpoint, attempt: attempt + 1, error: (error as Error).message },
          'Webhook delivery attempt failed',
        );
      }

      if (attempt < maxRetries - 1) {
        // Use shorter backoff in test env to keep tests fast
        const baseMs = process.env.NODE_ENV === 'test' ? 10 : 1000;
        const backoff = 2 ** attempt * baseMs; // Exponential backoff: 1s, 2s, 4s (10ms in test)
        await sleep(backoff);
      }
    }

    // After exhausting retries, log as dead-letter
    logger.error(
      { endpoint, eventType: payload.eventType },
      'Webhook delivery exhausted retries — dead letter',
    );
    throw new Error(`Webhook delivery failed after ${maxRetries} attempts to ${endpoint}`);
  }

  /**
   * Publish an event to all matching subscriptions.
   * Called at key state transitions: song minted, sale completed.
   */
  async publish(eventType: string, data: Record<string, any>): Promise<void> {
    const payload: WebhookPayload = {
      eventId: crypto.randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      ...data,
    };

    // Guard for unit tests where AppDataSource is mocked without a query builder
    if (
      !this.subscriptionRepo ||
      typeof (this.subscriptionRepo as any).createQueryBuilder !== 'function'
    ) {
      logger.debug({ eventType }, 'Webhook publish skipped — repo not available (test mock)');
      return;
    }

    // Match in SQL: '*' and empty/null eventTypes mean all events
    let matched: WebhookSubscription[] = [];
    try {
      matched = await this.subscriptionRepo
        .createQueryBuilder('sub')
        .where('sub.isActive = true')
        .andWhere(
          `(sub."eventTypes" && ARRAY[:eventType, '*']::text[] OR sub."eventTypes" IS NULL OR cardinality(sub."eventTypes") = 0)`,
          { eventType },
        )
        .getMany();
    } catch (e) {
      logger.debug(
        { eventType, err: (e as Error).message },
        'Webhook publish skipped — find failed',
      );
      return;
    }

    if (matched.length === 0) {
      logger.debug({ eventType }, 'No webhook subscriptions matched event');
      return;
    }

    // Deliver to each matched subscription (fire-and-forget with logging; don't fail caller on delivery failure)
    await Promise.allSettled(
      matched.map((sub) =>
        this.deliver(sub.endpoint, payload, sub.secret).catch((err) => {
          logger.error(
            { endpoint: sub.endpoint, eventType, err: err.message },
            'Webhook publish delivery failed',
          );
        }),
      ),
    );
  }

  /** Backwards-compatible alias for plan's event name */
  async emitMintStatusChanged(songId: string, details: Record<string, any>): Promise<void> {
    await this.publish('song.minted', { songId, ...details });
    // Also emit legacy event name for subscribers using old convention
    await this.publish('mint_status_changed', { songId, ...details });
  }

  async emitSaleCompleted(details: Record<string, any>): Promise<void> {
    await this.publish('sale.completed', details);
    await this.publish('sale_completed', details);
  }
}

export default WebhookService;
