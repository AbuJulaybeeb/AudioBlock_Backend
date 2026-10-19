import { IndexedEventService } from '../services/IndexedEventService';
import db from '../config/db';
jest.mock('../config/db', () => ({ __esModule: true, default: { getRepository: jest.fn() } }));
jest.mock('../config/logger', () => ({ __esModule: true, default: { debug: jest.fn() } }));
it('reports insert, existing, and concurrent-insert outcomes without changing returned entities', async () => {
  const row = { eventId: 'id' };
  const repo = {
    findOne: jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row),
    create: jest.fn().mockReturnValue(row),
    save: jest.fn().mockResolvedValueOnce(row).mockRejectedValueOnce({ code: '23505' }),
  };
  jest.mocked(db.getRepository).mockReturnValue(repo as any);
  const result = jest.fn();
  const service = new IndexedEventService();
  const dto = { eventId: 'id', eventType: 'mint', network: 'testnet', ledger: 1 };
  expect(await service.upsertEvent(dto, result)).toBe(row);
  expect(await service.upsertEvent(dto, result)).toBe(row);
  expect(await service.upsertEvent(dto, result)).toBe(row);
  expect(result.mock.calls).toEqual([[true], [false], [false]]);
});
