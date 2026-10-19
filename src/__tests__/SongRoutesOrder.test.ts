import 'reflect-metadata';
import express from 'express';
import request from 'supertest';

jest.mock('../controllers/SongController', () => {
  const handlers: Record<string, any> = {
    getSong: (_req: any, res: any) => res.status(200).json({ handler: 'getSong' }),
    listSongs: (_req: any, res: any) => res.status(200).json({ handler: 'listSongs' }),
    getPopularSongs: (_req: any, res: any) => res.status(200).json({ handler: 'popular' }),
    streamSong: (_req: any, res: any) => res.status(200).json({ handler: 'stream' }),
  };
  return {
    SongController: new Proxy(handlers, {
      get: (target, prop) => (prop in target ? target[prop as string] : jest.fn()),
    }),
  };
});
jest.mock('../controllers/EmbedController', () => ({
  EmbedController: {
    getSongEmbed: (_req: any, res: any) => res.status(200).json({ handler: 'embed' }),
  },
}));
jest.mock('../controllers/UploadController', () => ({
  UploadController: jest.fn().mockImplementation(() => ({
    uploadChunk: jest.fn(),
    uploadCover: jest.fn(),
    finalizeUpload: jest.fn(),
    suggestTagsAndGenres: jest.fn(),
  })),
}));
jest.mock('../middlewares/authMiddleware', () => ({
  authArtistMiddleware: (_req: any, _res: any, next: any) => next(),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../middlewares/idempotency', () => ({
  idempotency: () => (_req: any, _res: any, next: any) => next(),
}));

import SongRoutes from '../routes/SongRoutes';

const app = express();
app.use('/api/song', SongRoutes);

describe('SongRoutes GET ordering (#810, #811)', () => {
  it('routes /:id to getSong', async () => {
    const res = await request(app).get('/api/song/3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b');
    expect(res.body).toEqual({ handler: 'getSong' });
  });

  it('routes / to listSongs', async () => {
    const res = await request(app).get('/api/song');
    expect(res.body).toEqual({ handler: 'listSongs' });
  });

  it('keeps /popular on its own handler', async () => {
    const res = await request(app).get('/api/song/popular');
    expect(res.body).toEqual({ handler: 'popular' });
  });

  it('keeps /stream/:id and /embed/:id on their own handlers', async () => {
    expect((await request(app).get('/api/song/stream/abc')).body).toEqual({ handler: 'stream' });
    expect((await request(app).get('/api/song/embed/abc')).body).toEqual({ handler: 'embed' });
  });
});
