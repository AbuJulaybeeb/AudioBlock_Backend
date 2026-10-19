import { reindexRange } from '../cli/reindex';
import { SorobanEventReader } from '../services/Soroban/SorobanEventReader';
import { IndexedEventService } from '../services/IndexedEventService';
import db from '../config/db';

jest.mock('../services/Soroban/SorobanEventReader');
jest.mock('../services/IndexedEventService');
jest.mock('../config/db', () => ({
  __esModule: true,
  default: { isInitialized: false, initialize: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('../config/soroban', () => ({
  SorobanContracts: {
    nft: 'C123',
    artist: 'C234',
    catalog: 'C345',
    royalty: 'C456',
    marketplace: 'C567',
  },
}));
const options = { contract: 'C123', network: 'testnet', from: 10, to: 11 };
const event = (id: string, ledger = 10) => ({
  id,
  ledger,
  topic: ['mint'],
  value: 42,
  contractId: 'C123',
  txHash: 'tx',
});
const fetchEvents = jest.mocked(SorobanEventReader.prototype.fetchEvents);
const upsert = jest.mocked(IndexedEventService.prototype.upsertEvent);

beforeEach(() => {
  jest.clearAllMocks();
  fetchEvents.mockReset();
  fetchEvents.mockResolvedValue({ events: [], cursor: '', latestLedger: 20 });
  upsert.mockImplementation(async (_dto, result) => {
    result?.(true);
    return {} as any;
  });
});

it('pages by cursor without skipping events in the same or final ledger', async () => {
  fetchEvents
    .mockResolvedValueOnce({ events: [event('1')], cursor: 'a', latestLedger: 20 })
    .mockResolvedValueOnce({ events: [event('2'), event('3', 11)], cursor: 'b', latestLedger: 20 })
    .mockResolvedValueOnce({ events: [event('4', 12)], cursor: 'c', latestLedger: 20 });
  const summary = await reindexRange(options);
  expect(summary).toMatchObject({ fetched: 3, inserted: 3, failed: 0, perType: { mint: 3 } });
  expect(fetchEvents).toHaveBeenNthCalledWith(1, {
    contractIds: ['C123'],
    startLedger: 10,
    endLedger: 12,
    limit: 200,
  });
  expect(fetchEvents).toHaveBeenNthCalledWith(2, {
    contractIds: ['C123'],
    cursor: 'a',
    limit: 200,
  });
  expect(upsert).toHaveBeenCalledTimes(3);
  expect(db.destroy).toHaveBeenCalledTimes(1);
});

it('reports duplicates on replay using the upsert outcome', async () => {
  const seen = new Set();
  upsert.mockImplementation(async (dto, result) => {
    result?.(!seen.has(dto.eventId));
    seen.add(dto.eventId);
    return {} as any;
  });
  fetchEvents.mockResolvedValue({ events: [event('1')], cursor: '', latestLedger: 20 });
  expect(await reindexRange(options)).toMatchObject({ inserted: 1, alreadyPresent: 0 });
  expect(await reindexRange(options)).toMatchObject({ inserted: 0, alreadyPresent: 1 });
});

it('decodes and counts dry runs without opening the DB or writing', async () => {
  fetchEvents.mockResolvedValue({ events: [event('1')], cursor: '', latestLedger: 20 });
  expect(await reindexRange({ ...options, dryRun: true })).toMatchObject({
    fetched: 1,
    inserted: 0,
    perType: { mint: 1 },
  });
  expect(upsert).not.toHaveBeenCalled();
  expect(db.initialize).not.toHaveBeenCalled();
});

it('counts failed writes and continues', async () => {
  fetchEvents.mockResolvedValue({ events: [event('1'), event('2')], cursor: '', latestLedger: 20 });
  upsert.mockRejectedValueOnce(new Error('DB failed'));
  expect(await reindexRange(options)).toMatchObject({ failed: 1, inserted: 1 });
});

it('rejects stuck pagination', async () => {
  fetchEvents.mockResolvedValue({ events: [event('1')], cursor: 'same', latestLedger: 20 });
  await expect(reindexRange(options)).rejects.toThrow('cursor did not advance');
});

it.each([
  { from: -1 },
  { from: NaN },
  { to: 9 },
  { to: 10.5 },
  { network: 'devnet' },
  { contract: 'unknown' },
])('rejects invalid arguments %j', async (invalid) => {
  await expect(reindexRange({ ...options, ...invalid })).rejects.toThrow();
  expect(fetchEvents).not.toHaveBeenCalled();
});

it('counts unknown decoded event types separately', async () => {
  fetchEvents.mockResolvedValue({
    events: [{ ...event('1'), topic: ['unknown'] }],
    cursor: '',
    latestLedger: 20,
  });
  expect(await reindexRange({ ...options, dryRun: true })).toMatchObject({
    fetched: 1,
    skipped: 1,
    perType: {},
  });
});
it('closes an owned database connection after RPC failure', async () => {
  fetchEvents.mockRejectedValue(new Error('RPC unavailable'));
  await expect(reindexRange(options)).rejects.toThrow('RPC unavailable');
  expect(db.destroy).toHaveBeenCalledTimes(1);
});

it('continues past an empty normalized page when its cursor advances', async () => {
  fetchEvents
    .mockResolvedValueOnce({ events: [], cursor: 'a', latestLedger: 20 })
    .mockResolvedValueOnce({ events: [event('1')], cursor: 'b', latestLedger: 20 })
    .mockResolvedValueOnce({ events: [], cursor: 'b', latestLedger: 20 });
  expect(await reindexRange(options)).toMatchObject({ inserted: 1 });
  expect(fetchEvents).toHaveBeenCalledTimes(3);
});
