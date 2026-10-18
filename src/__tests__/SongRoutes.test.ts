import 'reflect-metadata';

// Stable fake repository per entity so services built at module load share them.
jest.mock('../config/db', () => {
  const repos: Record<string, any> = {};
  const make = () => ({
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (v: unknown) => v),
    remove: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
  });
  return {
    __esModule: true,
    default: { getRepository: (entity: { name: string }) => (repos[entity.name] ??= make()) },
  };
});

const mockRedisCount = { value: 1 };
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(() => {
      const p: any = {};
      for (const m of ['zremrangebyscore', 'zadd', 'zcard', 'expire']) p[m] = jest.fn(() => p);
      p.exec = jest.fn(async () => [null, null, [null, mockRedisCount.value], null]);
      return p;
    }),
  },
}));
jest.mock('../config/rabbitmq', () => ({ getChannel: jest.fn() }));
jest.mock('../config/s3', () => ({
  s3: {
    deleteObjects: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    listObjectsV2: jest.fn(() => ({
      promise: jest.fn().mockResolvedValue({ Contents: [{ Key: 'songs/s1/hls/master.m3u8' }] }),
    })),
  },
}));
jest.mock('../config/soroban', () => ({ SorobanContracts: {} }));
jest.mock('../services/Soroban/SorobanService', () => ({
  SorobanService: jest.fn(),
  addressArg: jest.fn(),
  stringArg: jest.fn(),
  u64Arg: jest.fn(),
}));
jest.mock('../services/PinataService', () => ({
  PinataService: { uploadFile: jest.fn(async () => ({ cid: 'cid-new' })) },
}));
jest.mock('fluent-ffmpeg', () => {
  const handlers: Record<string, () => void> = {};
  const instance: any = {
    outputOptions: jest.fn(() => instance),
    output: jest.fn(() => instance),
    on: jest.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
      return instance;
    }),
    run: jest.fn(() => handlers['end']?.()),
  };
  return { __esModule: true, default: jest.fn(() => instance) };
});
jest.mock('../services/CacheService', () => ({
  CacheService: { clearSong: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/SearchIndexService', () => ({
  SearchIndexService: { scheduleRemoval: jest.fn(), scheduleIndexUpdate: jest.fn() },
}));
jest.mock('../workers/precomputeManifest', () => ({ precomputeSignedManifest: jest.fn() }));
jest.mock('../controllers/UploadController', () => ({
  UploadController: jest.fn(() => ({
    uploadChunk: jest.fn(),
    uploadCover: jest.fn(),
    finalizeUpload: jest.fn(),
    suggestTagsAndGenres: jest.fn(),
  })),
}));
jest.mock('../controllers/EmbedController', () => ({
  EmbedController: { getSongEmbed: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import AppDataSource from '../config/db';
import { s3 } from '../config/s3';
import SongRoutes from '../routes/SongRoutes';
import { PinataService } from '../services/PinataService';
import { ReportService } from '../services/ReportService';
import { Song } from '../entities/Song';
import { SongVersion } from '../entities/SongVersion';
import { ContentReport } from '../entities/ContentReport';
import { generateAuthToken } from '../../tests/helpers';

const app = express();
app.use(express.json());
app.use('/api/song', SongRoutes);
// Mirrors the upload-error mapping in src/app.ts.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: err.message });
});

const songRepo = AppDataSource.getRepository(Song) as any;
const versionRepo = AppDataSource.getRepository(SongVersion) as any;
const reportRepo = AppDataSource.getRepository(ContentReport) as any;

const owner = `Bearer ${generateAuthToken('owner-1', { role: 'artist' })}`;
const other = `Bearer ${generateAuthToken('other-1', { role: 'artist' })}`;
const admin = `Bearer ${generateAuthToken('admin-1', { role: 'admin' })}`;
const listener = `Bearer ${generateAuthToken('listener-1', { role: 'listener' })}`;

function makeSong(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    artistId: 'owner-1',
    title: 'Old title',
    description: 'desc',
    coverArtPath: 'https://bucket.s3.eu-north-1.amazonaws.com/covers/f_cover.png',
    s3OriginalUrl: 'https://bucket.s3.eu-north-1.amazonaws.com/uploads/f.mp3',
    status: 'ready',
    flagged: false,
    mintStatus: 'not_minted',
    playCount: 7,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AWS_BUCKET_NAME = 'bucket';
  mockRedisCount.value = 1;
  songRepo.save.mockImplementation(async (v: unknown) => v);
});

describe('PATCH /api/song/:id', () => {
  it('rejects a caller who does not own the song', async () => {
    songRepo.findOne.mockResolvedValue(makeSong());
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', other)
      .send({ title: 'x' });
    expect(res.status).toBe(403);
    expect(songRepo.save).not.toHaveBeenCalled();
  });

  it('rejects a listener before touching the song', async () => {
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', listener)
      .send({ title: 'x' });
    expect(res.status).toBe(403);
    expect(songRepo.findOne).not.toHaveBeenCalled();
  });

  it('writes only allow-listed fields', async () => {
    const song = makeSong();
    songRepo.findOne.mockResolvedValue(song);
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', owner)
      .send({ title: 'New title', artistId: 'attacker', mintStatus: 'minted', playCount: 999 });
    expect(res.status).toBe(200);
    expect(song).toMatchObject({
      title: 'New title',
      artistId: 'owner-1',
      mintStatus: 'not_minted',
      playCount: 7,
    });
  });

  it('lets an admin edit any song', async () => {
    songRepo.findOne.mockResolvedValue(makeSong());
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', admin)
      .send({ title: 'Fixed' });
    expect(res.status).toBe(200);
  });

  it('returns 409 when changing on-chain metadata of a minted song', async () => {
    songRepo.findOne.mockResolvedValue(makeSong({ mintStatus: 'minted' }));
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', owner)
      .send({ title: 'Renamed' });
    expect(res.status).toBe(409);
    expect(songRepo.save).not.toHaveBeenCalled();
  });

  it('still allows off-chain edits on a minted song', async () => {
    songRepo.findOne.mockResolvedValue(makeSong({ mintStatus: 'minted' }));
    const res = await request(app)
      .patch('/api/song/s1')
      .set('Authorization', owner)
      .send({ lyrics: 'la la' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/song/:id', () => {
  it('rejects a caller who does not own the song', async () => {
    songRepo.findOne.mockResolvedValue(makeSong());
    const res = await request(app).delete('/api/song/s1').set('Authorization', other);
    expect(res.status).toBe(403);
    expect(songRepo.remove).not.toHaveBeenCalled();
    expect(s3.deleteObjects).not.toHaveBeenCalled();
  });

  it('removes an unminted song and its S3 objects', async () => {
    const song = makeSong();
    songRepo.findOne.mockResolvedValue(song);
    const res = await request(app).delete('/api/song/s1').set('Authorization', owner);
    expect(res.status).toBe(200);
    expect(songRepo.remove).toHaveBeenCalledWith(song);
    expect(s3.deleteObjects).toHaveBeenCalledWith({
      Bucket: 'bucket',
      Delete: { Objects: [{ Key: 'uploads/f.mp3' }, { Key: 'covers/f_cover.png' }] },
    });
    expect(s3.listObjectsV2).toHaveBeenCalledWith(
      expect.objectContaining({ Prefix: 'songs/s1/hls/' }),
    );
    expect(s3.deleteObjects).toHaveBeenCalledWith({
      Bucket: 'bucket',
      Delete: { Objects: [{ Key: 'songs/s1/hls/master.m3u8' }] },
    });
  });

  it('hides a minted song instead of deleting it', async () => {
    const song = makeSong({ mintStatus: 'minted' });
    songRepo.findOne.mockResolvedValue(song);
    const res = await request(app).delete('/api/song/s1').set('Authorization', owner);
    expect(res.status).toBe(200);
    expect(res.body.data.hidden).toBe(true);
    expect(songRepo.remove).not.toHaveBeenCalled();
    expect(s3.deleteObjects).not.toHaveBeenCalled();
    expect(song.flagged).toBe(true);
  });
});

describe('GET /api/song/:id/lyrics', () => {
  it('does not serve lyrics whose rights were not confirmed', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong({ lyrics: 'secret' }));
    const res = await request(app).get('/api/song/s1/lyrics');
    expect(res.status).toBe(404);
  });

  it('serves confirmed lyrics publicly', async () => {
    songRepo.findOneBy.mockResolvedValue(
      makeSong({ lyrics: 'hello', language: 'en', lyricsRightsConfirmedAt: new Date() }),
    );
    const res = await request(app).get('/api/song/s1/lyrics');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ lyrics: 'hello', language: 'en' });
  });
});

describe('cover endpoints', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);

  it('serves cover URLs publicly', async () => {
    songRepo.findOneBy.mockResolvedValue(
      makeSong({ coverArtIpfsHash: 'cid', coverArtThumbnails: { '150': 'u' } }),
    );
    const res = await request(app).get('/api/song/s1/cover');
    expect(res.status).toBe(200);
    expect(res.body.data.thumbnails).toEqual({ '150': 'u' });
  });

  it('rejects a non-owner', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong());
    const res = await request(app)
      .put('/api/song/s1/cover')
      .set('Authorization', other)
      .attach('cover', png, { filename: 'c.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid image type', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong());
    const res = await request(app)
      .put('/api/song/s1/cover')
      .set('Authorization', owner)
      .attach('cover', Buffer.from('GIF89a'), { filename: 'c.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
    expect(PinataService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an oversized image', async () => {
    const res = await request(app)
      .put('/api/song/s1/cover')
      .set('Authorization', owner)
      .attach('cover', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'c.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(413);
    expect(PinataService.uploadFile).not.toHaveBeenCalled();
  });

  it('replaces the cover and deletes the previous one from S3', async () => {
    const song = makeSong();
    songRepo.findOneBy.mockResolvedValue(song);
    const res = await request(app)
      .put('/api/song/s1/cover')
      .set('Authorization', owner)
      .attach('cover', png, { filename: 'c.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(song.coverArtPath).toContain('/ipfs/cid-new');
    expect(s3.deleteObjects).toHaveBeenCalledWith({
      Bucket: 'bucket',
      Delete: { Objects: [{ Key: 'covers/f_cover.png' }] },
    });
  });
});

describe('version history endpoints', () => {
  it('rejects anonymous callers', async () => {
    const res = await request(app).get('/api/song/s1/versions');
    expect(res.status).toBe(401);
  });

  it('rejects a non-owner on list and fetch', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong());
    const list = await request(app).get('/api/song/s1/versions').set('Authorization', other);
    const one = await request(app).get('/api/song/s1/versions/1').set('Authorization', other);
    expect(list.status).toBe(403);
    expect(one.status).toBe(403);
  });

  it('lets the owner list a page of versions and fetch one', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong());
    versionRepo.findAndCount.mockResolvedValue([[{ versionNumber: 2 }], 3]);
    versionRepo.findOne.mockResolvedValue({ versionNumber: 1 });

    const list = await request(app)
      .get('/api/song/s1/versions?page=2&limit=1')
      .set('Authorization', owner);
    expect(list.status).toBe(200);
    expect(list.body.pagination).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect(versionRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 1 }),
    );

    const one = await request(app).get('/api/song/s1/versions/1').set('Authorization', owner);
    expect(one.status).toBe(200);
    expect(one.body.data.versionNumber).toBe(1);
  });

  it('lets an admin read the history', async () => {
    songRepo.findOneBy.mockResolvedValue(makeSong());
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    const res = await request(app).get('/api/song/s1/versions').set('Authorization', admin);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/song/:id/report', () => {
  const stored: any[] = [];

  beforeEach(() => {
    stored.length = 0;
    songRepo.findOneBy.mockResolvedValue(makeSong());
    reportRepo.save.mockImplementation(async (r: any) => {
      stored.push({ id: `r${stored.length + 1}`, ...r });
      return r;
    });
    reportRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        stored.find((r) => r.songId === where.songId && r.reporterId === where.reporterId) ?? null,
    );
    reportRepo.count.mockImplementation(async () => stored.length);
    reportRepo.findAndCount.mockImplementation(async () => [stored, stored.length]);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/song/s1/report').send({ reason: 'spam' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid reason', async () => {
    const res = await request(app)
      .post('/api/song/s1/report')
      .set('Authorization', listener)
      .send({ reason: 'not-a-reason' });
    expect(res.status).toBe(400);
  });

  it('files a report that shows up in the admin queue, and rejects a duplicate with 409', async () => {
    const first = await request(app)
      .post('/api/song/s1/report')
      .set('Authorization', listener)
      .send({ reason: 'spam', description: 'looks fake' });
    expect(first.status).toBe(201);

    const queue = await new ReportService().listPendingReports();
    expect(queue.reports).toHaveLength(1);
    expect(queue.reports[0]).toMatchObject({ songId: 's1', reporterId: 'listener-1' });

    const second = await request(app)
      .post('/api/song/s1/report')
      .set('Authorization', listener)
      .send({ reason: 'spam' });
    expect(second.status).toBe(409);
    expect(stored).toHaveLength(1);
  });

  it('returns 429 once a user exceeds 10 reports in the window', async () => {
    mockRedisCount.value = 11;
    const res = await request(app)
      .post('/api/song/s1/report')
      .set('Authorization', listener)
      .send({ reason: 'spam' });
    expect(res.status).toBe(429);
    expect(reportRepo.save).not.toHaveBeenCalled();
  });
});
