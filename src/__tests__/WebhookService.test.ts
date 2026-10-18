import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import AppDataSource from '../config/db';
import { WebhookService } from '../services/WebhookService';

describe('WebhookService', () => {
  let mockRepo: any;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepo = {
      create: jest.fn((data) => ({ id: 'sub-id', ...data })),
      save: jest.fn(async (data) => ({
        ...data,
        id: data.id || 'sub-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      remove: jest.fn(async () => {}),
    };
    (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockRepo);
    fetchMock = jest.fn();
  });

  describe('registerSubscription', () => {
    it('allows third party to register a webhook URL', async () => {
      const svc = new WebhookService(fetchMock);
      const sub = await svc.registerSubscription(
        'user-1',
        'https://example.com/webhook',
        ['song.minted'],
        'secret123',
      );
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://example.com/webhook' }),
      );
      expect(mockRepo.save).toHaveBeenCalled();
      expect(sub.endpoint).toBe('https://example.com/webhook');
      expect(sub.secret).toBe('secret123');
    });

    it('rejects invalid URLs', async () => {
      const svc = new WebhookService(fetchMock);
      await expect(
        svc.registerSubscription('user-1', 'not-a-url', ['song.minted']),
      ).rejects.toThrow('Invalid endpoint URL');
    });

    it('generates a secret if not provided and stores eventTypes', async () => {
      const svc = new WebhookService(fetchMock);
      const sub = await svc.registerSubscription('user-1', 'https://example.com/hook', [
        'sale.completed',
      ]);
      expect(sub.secret).toBeDefined();
      expect(sub.secret.length).toBeGreaterThan(10);
      expect(sub.eventTypes).toEqual(['sale.completed']);
    });
  });

  describe('signPayload & verify', () => {
    it('creates valid HMAC-SHA256 signature and verifies correctly (signed event payloads)', async () => {
      const svc = new WebhookService(fetchMock);
      const payload = {
        eventId: 'evt-1',
        eventType: 'song.minted',
        timestamp: new Date().toISOString(),
        songId: 's1',
      };
      const secret = 'mysecret';
      const sig = svc.signPayload(payload, secret);
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
      expect(svc.verifySignature(payload, sig, secret)).toBe(true);
      expect(svc.verifySignature(payload, sig, 'wrong')).toBe(false);
      // tampered payload should fail
      const tampered = { ...payload, songId: 's2' };
      expect(svc.verifySignature(tampered, sig, secret)).toBe(false);
    });

    it('signature is deterministic for same payload+secret', async () => {
      const svc = new WebhookService(fetchMock);
      const payload = { eventType: 'sale.completed', txHash: 'abc' };
      const s1 = svc.signPayload(payload, 'k1');
      const s2 = svc.signPayload(payload, 'k1');
      expect(s1).toBe(s2);
    });
  });

  describe('deliver with retry and backoff', () => {
    it('retries with exponential backoff on failure and eventually succeeds', async () => {
      // Fail 2 times, then succeed
      fetchMock
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ ok: false, status: 500 } as any)
        .mockResolvedValueOnce({ ok: true, status: 200 } as any);

      const svc = new WebhookService(fetchMock);
      const payload: any = {
        eventId: 'e1',
        eventType: 'song.minted',
        timestamp: new Date().toISOString(),
      };
      await svc.deliver('https://example.com/hook', payload, 'secret');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Check that signature header was sent
      const lastCallHeaders = fetchMock.mock.calls[2][1].headers;
      expect(lastCallHeaders['X-Webhook-Signature']).toMatch(/^[a-f0-9]{64}$/);
      expect(lastCallHeaders['Content-Type']).toBe('application/json');
    });

    it('throws after exhausting max retries (dead letter)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 } as any);
      const svc = new WebhookService(fetchMock);
      const payload: any = {
        eventId: 'e2',
        eventType: 'sale.completed',
        timestamp: new Date().toISOString(),
      };
      await expect(svc.deliver('https://example.com/hook', payload, 'secret')).rejects.toThrow(
        'Webhook delivery failed after 3 attempts',
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('succeeds on first try without retry', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 } as any);
      const svc = new WebhookService(fetchMock);
      const payload: any = {
        eventId: 'e3',
        eventType: 'song.minted',
        timestamp: new Date().toISOString(),
      };
      await svc.deliver('https://example.com/hook', payload, 'secret');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('publish filtering', () => {
    let qb: any;

    beforeEach(() => {
      qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => []),
      };
      mockRepo.createQueryBuilder = jest.fn(() => qb);
    });

    it('matches in SQL instead of loading all active subscriptions', async () => {
      const svc = new WebhookService(fetchMock);
      await svc.publish('song.minted', { songId: 's1' });

      expect(mockRepo.find).not.toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('sub.isActive = true');
      const [sql, params] = qb.andWhere.mock.calls[0];
      // exact event type or the '*' wildcard
      expect(sql).toContain(`sub."eventTypes" && ARRAY[:eventType, '*']::text[]`);
      // empty array means all events
      expect(sql).toContain('cardinality(sub."eventTypes") = 0');
      // null (legacy rows) means all events
      expect(sql).toContain('sub."eventTypes" IS NULL');
      expect(params).toEqual({ eventType: 'song.minted' });
    });

    it('delivers to each subscription the query returns', async () => {
      qb.getMany.mockResolvedValue([
        { id: '1', endpoint: 'https://a.com/hook', secret: 's1', eventTypes: ['song.minted'] },
        { id: '3', endpoint: 'https://c.com/hook', secret: 's3', eventTypes: ['*'] },
        { id: '4', endpoint: 'https://d.com/hook', secret: 's4', eventTypes: [] },
      ]);
      fetchMock.mockResolvedValue({ ok: true } as any);

      const svc = new WebhookService(fetchMock);
      await svc.publish('song.minted', { songId: 's1', title: 'Test' });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledWith('https://a.com/hook', expect.any(Object));
      expect(fetchMock).toHaveBeenCalledWith('https://c.com/hook', expect.any(Object));
      expect(fetchMock).toHaveBeenCalledWith('https://d.com/hook', expect.any(Object));
    });

    it('does nothing when no subscriptions match', async () => {
      fetchMock.mockResolvedValue({ ok: true } as any);
      const svc = new WebhookService(fetchMock);
      await svc.publish('song.minted', { songId: 's1' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not throw when the query fails', async () => {
      qb.getMany.mockRejectedValue(new Error('db down'));
      const svc = new WebhookService(fetchMock);
      await expect(svc.publish('song.minted', {})).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('list and delete', () => {
    it('lists subscriptions for a user', async () => {
      mockRepo.find.mockResolvedValue([{ id: '1', userId: 'u1' }]);
      const svc = new WebhookService(fetchMock);
      const list = await svc.listSubscriptions('u1');
      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { createdAt: 'DESC' },
      });
      expect(list).toHaveLength(1);
    });

    it('deletes own subscription', async () => {
      mockRepo.findOne.mockResolvedValue({ id: 'sub-1', userId: 'u1' });
      const svc = new WebhookService(fetchMock);
      await svc.deleteSubscription('u1', 'sub-1');
      expect(mockRepo.remove).toHaveBeenCalled();
    });

    it('throws when trying to delete non-owned subscription', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      const svc = new WebhookService(fetchMock);
      await expect(svc.deleteSubscription('u1', 'missing')).rejects.toThrow(
        'Webhook subscription not found',
      );
    });
  });
});
