import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../config/rabbitmq', () => ({
  getChannel: jest.fn().mockReturnValue({ sendToQueue: jest.fn() }),
}));
jest.mock('../config/s3', () => ({
  s3: {
    upload: jest
      .fn()
      .mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: 's3://bucket/key' }) }),
  },
}));
jest.mock('../services/Soroban/SorobanService', () => ({
  SorobanService: jest.fn().mockImplementation(() => ({
    prepareInvocation: jest.fn(),
    submitSignedTransaction: jest.fn(),
  })),
  addressArg: jest.fn((v) => v),
  stringArg: jest.fn((v) => v),
  u64Arg: jest.fn((v) => v),
}));
jest.mock('../config/soroban', () => ({
  SorobanContracts: { catalog: 'CATALOG_CONTRACT' },
  getNetworkPassphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
  getSorobanServer: jest.fn(),
  getSorobanRpcUrl: jest.fn(),
}));

import AppDataSource from '../config/db';
import { SongService } from '../services/SongService';
import { Song } from '../entities/Song';

const SONG_ID = '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b';
const OWNER_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const mockSongRepo = { findOne: jest.fn(), createQueryBuilder: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockSongRepo);
});

function makeSong(overrides: Partial<Song> = {}) {
  return {
    id: SONG_ID,
    artistId: OWNER_ID,
    title: 'Track',
    description: 'desc',
    coverArtPath: 'cover.png',
    coverArtThumbnails: null,
    genre: 'Rock',
    genreId: 'g1',
    duration: 180,
    playCount: 7,
    status: 'ready',
    mintStatus: 'minted',
    onChainSongId: '1',
    onChainTokenId: '2',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    errorReason: 'transcode failed',
    flagged: false,
    s3OriginalUrl: 's3://secret',
    flagReason: 'moderation note',
    aiGeneratedDescription: 'draft',
    user: {
      id: OWNER_ID,
      username: 'artist',
      name: 'Artist',
      profileImage: 'p.png',
      email: 'x@y.z',
    },
    ...overrides,
  } as unknown as Song;
}

describe('SongService.getSongView (#810)', () => {
  it('returns the shaped song for a ready song', async () => {
    mockSongRepo.findOne.mockResolvedValue(makeSong());

    const view: any = await new SongService().getSongView(SONG_ID);

    expect(view).toMatchObject({
      id: SONG_ID,
      title: 'Track',
      artist: { id: OWNER_ID, username: 'artist', name: 'Artist', profileImage: 'p.png' },
      cover: { path: 'cover.png', thumbnails: null },
      genre: 'Rock',
      duration: 180,
      playCount: 7,
      mintStatus: 'minted',
      onChainSongId: '1',
      onChainTokenId: '2',
    });
    expect(view.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('does not expose internal, moderation or review fields', async () => {
    mockSongRepo.findOne.mockResolvedValue(makeSong());

    const view: any = await new SongService().getSongView(SONG_ID, OWNER_ID);

    for (const key of ['s3OriginalUrl', 'flagReason', 'aiGeneratedDescription', 'flagged']) {
      expect(view).not.toHaveProperty(key);
    }
    expect(view.artist).not.toHaveProperty('email');
  });

  it('hides errorReason from the public but shows it to the owner', async () => {
    mockSongRepo.findOne.mockResolvedValue(makeSong());

    const publicView: any = await new SongService().getSongView(SONG_ID);
    const ownerView: any = await new SongService().getSongView(SONG_ID, OWNER_ID);

    expect(publicView).not.toHaveProperty('errorReason');
    expect(ownerView.errorReason).toBe('transcode failed');
  });

  it('returns 404 to the public for flagged songs but shows them to the owner', async () => {
    mockSongRepo.findOne.mockResolvedValue(makeSong({ flagged: true }));

    await expect(new SongService().getSongView(SONG_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(new SongService().getSongView(SONG_ID, 'someone-else')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(new SongService().getSongView(SONG_ID, OWNER_ID)).resolves.toMatchObject({
      id: SONG_ID,
    });
  });

  it.each(['processing', 'failed'] as const)(
    'returns 404 to the public for %s songs but shows them to the owner',
    async (status) => {
      mockSongRepo.findOne.mockResolvedValue(makeSong({ status }));

      await expect(new SongService().getSongView(SONG_ID)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(new SongService().getSongView(SONG_ID, OWNER_ID)).resolves.toMatchObject({
        status,
      });
    },
  );

  it('returns 404 when the song does not exist', async () => {
    mockSongRepo.findOne.mockResolvedValue(null);

    await expect(new SongService().getSongView(SONG_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns 400 for a malformed id', async () => {
    await expect(new SongService().getSongView('not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockSongRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('SongService.listSongs (#811)', () => {
  function stubQueryBuilder(songs: Song[] = [], total = songs.length) {
    const qb: any = {
      leftJoinAndSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      setParameter: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      take: jest.fn(() => qb),
      subQuery: jest.fn(() => qb),
      select: jest.fn(() => qb),
      from: jest.fn(() => qb),
      innerJoin: jest.fn(() => qb),
      getQuery: jest.fn(() => '(SELECT 1)'),
      getManyAndCount: jest.fn(async () => [songs, total]),
    };
    mockSongRepo.createQueryBuilder.mockReturnValue(qb);
    return qb;
  }

  it('limits public callers to ready, unflagged songs', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({});

    expect(qb.where).toHaveBeenCalledWith('song.status = :ready', { ready: 'ready' });
    expect(qb.andWhere).toHaveBeenCalledWith('song.flagged = false');
  });

  it('keeps the visibility rules when a different artist is requested', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ artistId: OWNER_ID }, 'someone-else');

    expect(qb.where).toHaveBeenCalledWith('song.status = :ready', { ready: 'ready' });
    expect(qb.andWhere).toHaveBeenCalledWith('song.flagged = false');
  });

  it('rejects the status filter for non-owners', async () => {
    stubQueryBuilder();

    await expect(new SongService().listSongs({ status: 'failed' })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      new SongService().listSongs({ artistId: OWNER_ID, status: 'failed' }, 'someone-else'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lets an artist list their own songs by status', async () => {
    const qb = stubQueryBuilder([makeSong({ status: 'failed' })]);

    const result: any = await new SongService().listSongs(
      { artistId: OWNER_ID, status: 'failed' },
      OWNER_ID,
    );

    expect(qb.where).toHaveBeenCalledWith('song.status = :status', { status: 'failed' });
    expect(qb.where).not.toHaveBeenCalledWith('song.status = :ready', expect.anything());
    expect(result.data[0].errorReason).toBe('transcode failed');
  });

  it('does not restrict visibility when an artist lists their own songs', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ artistId: OWNER_ID }, OWNER_ID);

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalledWith('song.flagged = false');
  });

  it('filters by artist, genre and mint status', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ artistId: OWNER_ID, genreId: 'g1', mintStatus: 'minted' });

    expect(qb.andWhere).toHaveBeenCalledWith('song.artistId = :artistId', { artistId: OWNER_ID });
    expect(qb.andWhere).toHaveBeenCalledWith('song.genreId = :genreId', { genreId: 'g1' });
    expect(qb.andWhere).toHaveBeenCalledWith('song.mintStatus = :mintStatus', {
      mintStatus: 'minted',
    });
  });

  it('filters by tag slug through the song_tags subquery', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ tag: 'Lo-Fi' });

    const factory = qb.andWhere.mock.calls.find((c: unknown[]) => typeof c[0] === 'function')[0];
    expect(factory(qb)).toBe('song.id IN (SELECT 1)');
    expect(qb.where).toHaveBeenCalledWith('t.slug = :tag');
    expect(qb.setParameter).toHaveBeenCalledWith('tag', 'lo-fi');
  });

  it.each([
    [undefined, 'song.createdAt', 'DESC'],
    ['newest', 'song.createdAt', 'DESC'],
    ['popular', 'song.playCount', 'DESC'],
    ['title', 'song.title', 'ASC'],
  ] as const)('sorts by %s', async (sort, column, direction) => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ sort });

    expect(qb.orderBy).toHaveBeenCalledWith(column, direction);
  });

  it('returns data and pagination, defaulting to page 1 with 20 per page', async () => {
    const qb = stubQueryBuilder([makeSong()], 45);

    const result: any = await new SongService().listSongs({});

    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasMore: true,
    });
    expect(result.data[0]).not.toHaveProperty('s3OriginalUrl');
  });

  it('applies page and limit to the query', async () => {
    const qb = stubQueryBuilder();

    await new SongService().listSongs({ page: 3, limit: 10 });

    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(10);
  });
});
