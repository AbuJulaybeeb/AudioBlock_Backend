import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

const cacheStore = new Map<string, unknown>();
jest.mock('../CacheService', () => ({
  CacheService: {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, data: unknown) => {
      cacheStore.set(key, data);
    }),
    invalidatePattern: jest.fn(async () => undefined),
  },
}));

import AppDataSource from '../../config/db';
import { CacheService } from '../CacheService';
import { SongStatsService, parseWindow, STATS_CACHE_TTL_MS } from '../Song/SongStatsService';
import { Song } from '../../entities/Song';
import { SongPlayEvent } from '../../entities/SongPlayEvent';
import { SongSave } from '../../entities/SongSave';
import { RoyaltyPayout } from '../../entities/RoyaltyPayout';

/**
 * Query-builder stub: counts and raw rows are queued per-repository so each
 * aggregation call in the service consumes the next queued result.
 */
function makeRepoStub(results: { counts?: number[]; rawOne?: unknown[]; rawMany?: unknown[][] }) {
  const counts = [...(results.counts ?? [])];
  const rawOnes = [...(results.rawOne ?? [])];
  const rawManys = [...(results.rawMany ?? [])];

  const qb: any = {
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    innerJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    getCount: jest.fn(async () => counts.shift() ?? 0),
    getRawOne: jest.fn(async () => rawOnes.shift() ?? { total: 0 }),
    getRawMany: jest.fn(async () => rawManys.shift() ?? []),
  };

  return {
    createQueryBuilder: jest.fn(() => qb),
    findOneBy: jest.fn(),
    find: jest.fn(),
    qb,
  };
}

let playRepo: ReturnType<typeof makeRepoStub>;
let saveRepo: ReturnType<typeof makeRepoStub>;
let payoutRepo: ReturnType<typeof makeRepoStub>;
let songRepo: ReturnType<typeof makeRepoStub>;

function wireRepos() {
  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => {
    if (entity === SongPlayEvent) return playRepo;
    if (entity === SongSave) return saveRepo;
    if (entity === RoyaltyPayout) return payoutRepo;
    if (entity === Song) return songRepo;
    return songRepo;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  cacheStore.clear();
  playRepo = makeRepoStub({});
  saveRepo = makeRepoStub({});
  payoutRepo = makeRepoStub({});
  songRepo = makeRepoStub({});
  wireRepos();
});

describe('parseWindow', () => {
  it('defaults to 30d when absent', () => {
    expect(parseWindow(undefined)).toBe('30d');
    expect(parseWindow('')).toBe('30d');
  });

  it('accepts every supported window', () => {
    expect(parseWindow('7d')).toBe('7d');
    expect(parseWindow('30d')).toBe('30d');
    expect(parseWindow('90d')).toBe('90d');
    expect(parseWindow('all-time')).toBe('all-time');
  });

  it('rejects an unsupported window with a 400', () => {
    expect(() => parseWindow('1y')).toThrow(/Invalid window/);
    try {
      parseWindow('1y');
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('SongStatsService.getSongStats', () => {
  it('returns plays, saves, revenue, and unique listeners for the window', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1', artistId: 'artist-1' } as Song);
    // Current period, then previous period.
    playRepo = makeRepoStub({
      counts: [100, 50],
      rawMany: [
        [
          { listenerId: 'u1', listenerKey: null },
          { listenerId: 'u1', listenerKey: null },
          { listenerId: null, listenerKey: 'k1' },
        ],
        [{ listenerId: 'u1', listenerKey: null }],
      ],
    });
    saveRepo = makeRepoStub({ counts: [20, 10] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '5000' }, { total: '2500' }] });
    wireRepos();

    const stats = await new SongStatsService().getSongStats('song-1', '7d');

    expect(stats.totals).toEqual({
      plays: 100,
      saves: 20,
      revenueStroops: '5000',
      uniqueListeners: 2,
    });
    expect(stats.previous).toEqual({
      plays: 50,
      saves: 10,
      revenueStroops: '2500',
      uniqueListeners: 1,
    });
    expect(stats.window).toBe('7d');
    expect(stats.periodStart).not.toBeNull();
  });

  it('reports period-over-period comparison percentages', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1' } as Song);
    playRepo = makeRepoStub({ counts: [150, 100], rawMany: [[], []] });
    saveRepo = makeRepoStub({ counts: [5, 10] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '200' }, { total: '100' }] });
    wireRepos();

    const stats = await new SongStatsService().getSongStats('song-1', '30d');

    expect(stats.comparison).toEqual({
      plays: 50,
      saves: -50,
      revenue: 100,
      uniqueListeners: 0,
    });
  });

  it('returns null comparison for all-time (no prior period exists)', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1' } as Song);
    playRepo = makeRepoStub({ counts: [10], rawMany: [[]] });
    saveRepo = makeRepoStub({ counts: [1] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '1' }] });
    wireRepos();

    const stats = await new SongStatsService().getSongStats('song-1', 'all-time');

    expect(stats.periodStart).toBeNull();
    expect(stats.previous).toBeNull();
    expect(stats.comparison).toBeNull();
  });

  it('leaves a percentage null when the previous period had no activity', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1' } as Song);
    playRepo = makeRepoStub({ counts: [10, 0], rawMany: [[], []] });
    saveRepo = makeRepoStub({ counts: [0, 0] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '0' }, { total: '0' }] });
    wireRepos();

    const stats = await new SongStatsService().getSongStats('song-1', '7d');

    expect(stats.comparison?.plays).toBeNull();
    expect(stats.comparison?.saves).toBe(0);
  });

  it('caches results for 5 minutes and serves the cached copy', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1' } as Song);
    playRepo = makeRepoStub({ counts: [7, 0], rawMany: [[], []] });
    saveRepo = makeRepoStub({ counts: [0, 0] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '0' }, { total: '0' }] });
    wireRepos();

    const svc = new SongStatsService();
    await svc.getSongStats('song-1', '7d');

    expect(CacheService.set).toHaveBeenCalledWith(
      'stats:song:song-1:7d',
      expect.anything(),
      STATS_CACHE_TTL_MS,
    );

    songRepo.findOneBy.mockClear();
    const second = await svc.getSongStats('song-1', '7d');

    expect(second.totals.plays).toBe(7);
    expect(songRepo.findOneBy).not.toHaveBeenCalled();
  });

  it('404s for a song that does not exist', async () => {
    songRepo.findOneBy.mockResolvedValue(null);

    await expect(new SongStatsService().getSongStats('nope', '7d')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('keeps large stroop revenue totals exact as strings', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: 'song-1' } as Song);
    playRepo = makeRepoStub({ counts: [0, 0], rawMany: [[], []] });
    saveRepo = makeRepoStub({ counts: [0, 0] });
    payoutRepo = makeRepoStub({
      rawOne: [{ total: '92233720368547758' }, { total: '0' }],
    });
    wireRepos();

    const stats = await new SongStatsService().getSongStats('song-1', '90d');

    expect(stats.totals.revenueStroops).toBe('92233720368547758');
  });
});

describe('SongStatsService.getArtistStats', () => {
  it('aggregates across the artist catalog and ranks top songs', async () => {
    songRepo.find.mockResolvedValue([
      { id: 'song-1', title: 'First' },
      { id: 'song-2', title: 'Second' },
    ]);
    playRepo = makeRepoStub({
      counts: [300, 200],
      rawMany: [
        [{ listenerId: 'u1', listenerKey: null }],
        [{ listenerId: 'u1', listenerKey: null }],
        [
          { songId: 'song-2', plays: '200' },
          { songId: 'song-1', plays: '100' },
        ],
      ],
    });
    saveRepo = makeRepoStub({ counts: [40, 20] });
    payoutRepo = makeRepoStub({ rawOne: [{ total: '900' }, { total: '300' }] });
    wireRepos();

    const stats = await new SongStatsService().getArtistStats('artist-1', '30d');

    expect(stats.songCount).toBe(2);
    expect(stats.totals.plays).toBe(300);
    expect(stats.comparison?.plays).toBe(50);
    expect(stats.topSongs[0]).toEqual({ songId: 'song-2', title: 'Second', plays: 200 });
  });

  it('404s when the artist has no songs', async () => {
    songRepo.find.mockResolvedValue([]);

    await expect(new SongStatsService().getArtistStats('artist-x', '7d')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('SongStatsService.getArtistLifetimeTotals (#807)', () => {
  it('derives streams, stream time and unique listeners from play events', async () => {
    songRepo.find.mockResolvedValue([{ id: 'song-1' }, { id: 'song-2' }]);
    playRepo = makeRepoStub({
      counts: [5],
      rawOne: [{ total: '900' }],
      rawMany: [
        [
          { listenerId: 'u1', listenerKey: null },
          { listenerId: 'u1', listenerKey: null },
          { listenerId: null, listenerKey: 'k1' },
        ],
      ],
    });
    wireRepos();

    const totals = await new SongStatsService().getArtistLifetimeTotals('artist-1');

    expect(totals).toEqual({ totalStreams: 5, totalStreamTime: 900, uniqueListeners: 2 });
    expect(CacheService.set).toHaveBeenCalledWith(
      'stats:artist:artist-1:lifetime',
      totals,
      STATS_CACHE_TTL_MS,
    );
  });

  it('returns zeros for an artist with no songs', async () => {
    songRepo.find.mockResolvedValue([]);

    const totals = await new SongStatsService().getArtistLifetimeTotals('artist-2');

    expect(totals).toEqual({ totalStreams: 0, totalStreamTime: 0, uniqueListeners: 0 });
  });
});
