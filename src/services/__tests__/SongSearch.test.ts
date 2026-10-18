import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../../config/s3', () => ({ s3: {} }));
jest.mock('../../config/rabbitmq', () => ({ getChannel: jest.fn() }));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import AppDataSource from '../../config/db';
import { SongService } from '../SongService';

function makeQueryBuilder(rows: any[] = [], total = 0) {
  const qb: any = {};
  for (const m of [
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'addSelect',
    'setParameters',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

describe('SongService.searchSongs', () => {
  let qb: any;
  let service: SongService;

  beforeEach(() => {
    qb = makeQueryBuilder();
    (AppDataSource.getRepository as jest.Mock).mockReturnValue({
      createQueryBuilder: jest.fn(() => qb),
    });
    service = new SongService();
  });

  it('returns an empty page without querying for queries under 2 characters', async () => {
    const result = await service.searchSongs('a');

    expect(result).toEqual({ songs: [], total: 0, page: 1, limit: 20, totalPages: 0 });
    expect(qb.getManyAndCount).not.toHaveBeenCalled();
  });

  it('resolves each searched column as its own index-backed lookup', async () => {
    await service.searchSongs('dreams');

    const where = qb.andWhere.mock.calls.map((c: any[]) => c[0]).join('\n');
    for (const column of ['title', 'genre', 'composers', 'description']) {
      expect(where).toContain(`SELECT id FROM songs WHERE ${column} ILIKE :like`);
    }
    expect(where).toContain('u.name ILIKE :like OR u.username ILIKE :like');
    // the cross-table OR that defeated the trigram indexes is gone
    expect(where).not.toMatch(/artist\.name ILIKE :like OR/);
    expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), { like: '%dreams%' });
  });

  it('ranks exact title matches above description-only matches', async () => {
    await service.searchSongs('dreams');

    const caseExpr = qb.addSelect.mock.calls.find((c: any[]) => c[1] === 'relevance')[0] as string;
    const score = (clause: string) =>
      Number(new RegExp(`${clause}\\s+THEN (\\d+)`).exec(caseExpr)![1]);
    const exactTitle = score('WHEN song\\.title ILIKE :exact');
    const fallback = Number(/ELSE (\d+)/.exec(caseExpr)![1]);

    // a song that only matches through its description falls to the ELSE branch
    expect(exactTitle).toBeGreaterThan(score('WHEN song\\.title ILIKE :prefix'));
    expect(exactTitle).toBeGreaterThan(fallback);
    expect(qb.orderBy).toHaveBeenCalledWith('relevance', 'DESC');
    expect(qb.addOrderBy).toHaveBeenNthCalledWith(1, 'similarity', 'DESC');
    expect(qb.addOrderBy).toHaveBeenNthCalledWith(2, 'song.playCount', 'DESC');
  });

  it('keeps the response shape and pagination contract', async () => {
    qb.getManyAndCount.mockResolvedValue([
      [
        {
          id: 's1',
          title: 'Dreams',
          playCount: 3,
          user: { id: 'a1', username: 'artist', name: 'Artist', profileImage: 'p.png' },
        },
      ],
      41,
    ]);

    const result = await service.searchSongs('dreams', 2, 20);

    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(result).toMatchObject({ total: 41, page: 2, limit: 20, totalPages: 3 });
    expect(result.songs[0]).toMatchObject({
      id: 's1',
      title: 'Dreams',
      artist: { id: 'a1', username: 'artist', name: 'Artist', profileImage: 'p.png' },
    });
  });
});
