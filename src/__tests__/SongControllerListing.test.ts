import 'reflect-metadata';
import { SongController } from '../controllers/SongController';

const mockGetSongView = jest.fn();
const mockListSongs = jest.fn();
jest.mock('../services/SongService', () => ({
  SongService: jest.fn().mockImplementation(() => ({
    getSongView: (...args: unknown[]) => mockGetSongView(...args),
    listSongs: (...args: unknown[]) => mockListSongs(...args),
  })),
}));

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('SongController.getSong (#810)', () => {
  it('returns the shaped song for the caller', async () => {
    mockGetSongView.mockResolvedValue({ id: 'song-1' });
    const res = makeRes();

    await SongController.getSong({ params: { id: 'song-1' }, user: { id: 'u1' } } as any, res);

    expect(mockGetSongView).toHaveBeenCalledWith('song-1', 'u1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'song-1' } });
  });

  it('treats an unauthenticated caller as anonymous', async () => {
    mockGetSongView.mockResolvedValue({ id: 'song-1' });

    await SongController.getSong({ params: { id: 'song-1' } } as any, makeRes());

    expect(mockGetSongView).toHaveBeenCalledWith('song-1', undefined);
  });
});

describe('SongController.listSongs (#811)', () => {
  it('parses the query and returns data with pagination', async () => {
    const result = { data: [{ id: 'song-1' }], pagination: { page: 2, limit: 5 } };
    mockListSongs.mockResolvedValue(result);
    const res = makeRes();

    await SongController.listSongs(
      { query: { page: '2', limit: '5', sort: 'popular' }, user: { id: 'u1' } } as any,
      res,
    );

    expect(mockListSongs).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 5, sort: 'popular' }),
      'u1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, ...result });
  });

  it('rejects an unbounded limit with a 400', async () => {
    const res = makeRes();

    await SongController.listSongs({ query: { limit: '1000' } } as any, res);

    expect(mockListSongs).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
