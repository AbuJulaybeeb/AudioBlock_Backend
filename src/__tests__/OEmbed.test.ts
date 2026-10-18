import 'reflect-metadata';
import express from 'express';
import request from 'supertest';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') },
}));

import AppDataSource from '../config/db';
import oembedRoutes from '../routes/oembedRoutes';
import { Song } from '../entities/Song';
import { Album } from '../entities/Album';
import { User } from '../entities/User';

const HOST = 'https://listen.audioblock.test';

describe('GET /api/oembed', () => {
  const app = express();
  app.use('/api/oembed', oembedRoutes);

  let mockSongRepo: any;
  let mockAlbumRepo: any;
  let mockUserRepo: any;

  const readySong = {
    id: 'song-1',
    title: 'Test "Song"',
    coverArtPath: 'https://s3.example.com/cover.jpg',
    artistId: 'artist-1',
    status: 'ready',
    flagged: false,
  };

  beforeAll(() => {
    process.env.APP_URL = 'https://listen.audioblock.test';
  });

  beforeEach(() => {
    mockSongRepo = { findOne: jest.fn() };
    mockAlbumRepo = { findOne: jest.fn() };
    mockUserRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'artist-1', name: 'Artist Name' }),
    };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: any) => {
      if (entity === Song) return mockSongRepo;
      if (entity === Album) return mockAlbumRepo;
      if (entity === User) return mockUserRepo;
      return mockSongRepo;
    });
  });

  it('returns a spec-compliant rich response for a song URL', async () => {
    mockSongRepo.findOne.mockResolvedValue(readySong);

    const res = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1` });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '1.0',
      type: 'rich',
      provider_name: 'AudioBlocks',
      provider_url: HOST,
      title: 'Test "Song"',
      author_name: 'Artist Name',
      author_url: `${HOST}/artist/artist-1`,
      thumbnail_url: 'https://s3.example.com/cover.jpg',
      width: 480,
      height: 180,
    });
    expect(res.body.html).toContain(`<iframe src="${HOST}/embed/song/song-1"`);
    expect(res.body.html).toContain('title="Test &quot;Song&quot;"');
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('respects maxwidth and maxheight', async () => {
    mockSongRepo.findOne.mockResolvedValue(readySong);

    const res = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1`, maxwidth: '300', maxheight: '500', format: 'json' });

    expect(res.status).toBe(200);
    expect(res.body.width).toBe(300);
    expect(res.body.height).toBe(180);
    expect(res.body.html).toContain('width="300"');
  });

  it('returns 304 when If-None-Match matches', async () => {
    mockSongRepo.findOne.mockResolvedValue(readySong);
    const first = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1` });

    const second = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1` })
      .set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
  });

  it('resolves album URLs', async () => {
    mockAlbumRepo.findOne.mockResolvedValue({
      id: 'album-1',
      title: 'Album',
      coverArtPath: 'https://s3.example.com/album.jpg',
      artistId: 'artist-1',
      songs: [],
    });

    const res = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/album/album-1` });

    expect(res.status).toBe(200);
    expect(res.body.html).toContain(`${HOST}/embed/album/album-1`);
    expect(res.body.height).toBe(400);
  });

  it('rejects foreign hosts with 400', async () => {
    const res = await request(app)
      .get('/api/oembed')
      .query({ url: 'https://evil.example.com/song/song-1' });

    expect(res.status).toBe(400);
    expect(mockSongRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-song URL with 400', async () => {
    expect((await request(app).get('/api/oembed')).status).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/oembed')
          .query({ url: `${HOST}/about` })
      ).status,
    ).toBe(400);
  });

  it('returns 501 for format=xml', async () => {
    const res = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1`, format: 'xml' });

    expect(res.status).toBe(501);
  });

  it('returns 404 for unknown songs', async () => {
    mockSongRepo.findOne.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/missing` });

    expect(res.status).toBe(404);
  });

  it('returns 404 for flagged and unready songs', async () => {
    mockSongRepo.findOne.mockResolvedValueOnce({ ...readySong, flagged: true });
    mockSongRepo.findOne.mockResolvedValueOnce({ ...readySong, status: 'processing' });

    const flagged = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1` });
    const processing = await request(app)
      .get('/api/oembed')
      .query({ url: `${HOST}/song/song-1` });

    expect(flagged.status).toBe(404);
    expect(processing.status).toBe(404);
  });
});
