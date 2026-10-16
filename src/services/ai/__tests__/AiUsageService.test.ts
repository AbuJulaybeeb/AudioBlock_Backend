import 'reflect-metadata';

jest.mock('../../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

import AppDataSource from '../../../config/db';
import { AiUsageService } from '../AiUsageService';
import { AiGenerationRecord } from '../../../entities/AiGenerationRecord';
import { TweetDraft } from '../../../entities/TweetDraft';
import { User } from '../../../entities/User';

function mockQueryBuilder(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'groupBy', 'addGroupBy', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

let generationQb: ReturnType<typeof mockQueryBuilder>;
let draftQb: ReturnType<typeof mockQueryBuilder>;
const mockUserRepo = { find: jest.fn() };

function setup(generationRows: unknown[], draftRows: unknown[]) {
  generationQb = mockQueryBuilder(generationRows);
  draftQb = mockQueryBuilder(draftRows);
  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
    if (entity === AiGenerationRecord) return { createQueryBuilder: () => generationQb };
    if (entity === TweetDraft) return { createQueryBuilder: () => draftQb };
    if (entity === User) return mockUserRepo;
    return {};
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserRepo.find.mockResolvedValue([
    { id: 'artist-a', name: 'Artist A' },
    { id: 'artist-b', username: 'artist_b' },
  ]);
});

describe('AiUsageService.getUsageSummary (#289)', () => {
  it('aggregates usage by feature and by artist across AI sources', async () => {
    setup(
      [
        // Postgres returns COUNT(*) as a string.
        { feature: 'coverArt', userId: 'artist-a', status: 'completed', count: '3' },
        { feature: 'coverArt', userId: 'artist-a', status: 'failed', count: '1' },
        { feature: 'descriptions', userId: 'artist-b', status: 'completed', count: '2' },
        { feature: 'lyricsTranscription', userId: 'artist-b', status: 'pending', count: '1' },
      ],
      [{ userId: 'artist-a', count: '4' }],
    );

    const summary = await new AiUsageService().getUsageSummary();

    expect(summary.totals).toEqual({ total: 11, completed: 9, failed: 1, pending: 1 });
    expect(summary.byFeature).toEqual([
      { feature: 'coverArt', total: 4, completed: 3, failed: 1, pending: 0 },
      { feature: 'tweetDrafts', total: 4, completed: 4, failed: 0, pending: 0 },
      { feature: 'descriptions', total: 2, completed: 2, failed: 0, pending: 0 },
      { feature: 'lyricsTranscription', total: 1, completed: 0, failed: 0, pending: 1 },
    ]);
    expect(summary.byArtist).toEqual([
      {
        artistId: 'artist-a',
        artistName: 'Artist A',
        total: 8,
        completed: 7,
        failed: 1,
        pending: 0,
        byFeature: { coverArt: 4, tweetDrafts: 4 },
      },
      {
        artistId: 'artist-b',
        artistName: 'artist_b',
        total: 3,
        completed: 2,
        failed: 0,
        pending: 1,
        byFeature: { descriptions: 2, lyricsTranscription: 1 },
      },
    ]);
    expect(summary.artistCount).toBe(2);
    expect(summary.range).toEqual({ from: null, to: null });
  });

  it('groups in SQL by feature, artist and status', async () => {
    setup([], []);

    await new AiUsageService().getUsageSummary();

    expect(generationQb.groupBy).toHaveBeenCalledWith('r.feature');
    expect(generationQb.addGroupBy).toHaveBeenCalledWith('r.userId');
    expect(generationQb.addGroupBy).toHaveBeenCalledWith('r.status');
    expect(draftQb.groupBy).toHaveBeenCalledWith('d.userId');
  });

  it('applies the date range to every source', async () => {
    setup([], []);
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    const summary = await new AiUsageService().getUsageSummary({ from, to });

    for (const [qb, alias] of [
      [generationQb, 'r'],
      [draftQb, 'd'],
    ] as const) {
      expect(qb.andWhere).toHaveBeenCalledWith(`${alias}.createdAt >= :from`, { from });
      expect(qb.andWhere).toHaveBeenCalledWith(`${alias}.createdAt <= :to`, { to });
    }
    expect(summary.range).toEqual({ from: from.toISOString(), to: to.toISOString() });
  });

  it('caps the artist list but still reports the total artist count', async () => {
    setup(
      [
        { feature: 'coverArt', userId: 'artist-a', status: 'completed', count: 5 },
        { feature: 'coverArt', userId: 'artist-b', status: 'completed', count: 2 },
      ],
      [],
    );

    const summary = await new AiUsageService().getUsageSummary({ artistLimit: 1 });

    expect(summary.byArtist.map((a) => a.artistId)).toEqual(['artist-a']);
    expect(summary.artistCount).toBe(2);
  });

  it('returns empty aggregates and skips the user lookup when there is no usage', async () => {
    setup([], []);

    const summary = await new AiUsageService().getUsageSummary();

    expect(summary.totals).toEqual({ total: 0, completed: 0, failed: 0, pending: 0 });
    expect(summary.byFeature).toEqual([]);
    expect(summary.byArtist).toEqual([]);
    expect(mockUserRepo.find).not.toHaveBeenCalled();
  });
});
