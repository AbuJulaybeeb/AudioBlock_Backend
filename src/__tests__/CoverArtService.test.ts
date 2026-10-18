import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

jest.mock('../services/PinataService', () => ({
  PinataService: { uploadFile: jest.fn() },
}));

jest.mock('../services/CacheService', () => ({
  CacheService: { clearSong: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../utils/s3Cleanup', () => ({
  s3KeyFromUrl: jest.fn((url?: string) =>
    url?.startsWith('https://b.s3') ? 'covers/old.png' : null,
  ),
  deleteS3Objects: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fluent-ffmpeg', () => {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const instance: any = {
    outputOptions: jest.fn(() => instance),
    output: jest.fn(() => instance),
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
      return instance;
    }),
    run: jest.fn(() => {
      handlers['end']?.();
    }),
  };
  const ffmpegMock = jest.fn(() => instance);
  return { __esModule: true, default: ffmpegMock };
});

import AppDataSource from '../config/db';
import { CoverArtService } from '../services/CoverArtService';
import { PinataService } from '../services/PinataService';
import { Song } from '../entities/Song';
import { CacheService } from '../services/CacheService';
import { deleteS3Objects } from '../utils/s3Cleanup';

const mockSongRepo = {
  findOneBy: jest.fn(),
  save: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockSongRepo);
  (PinataService.uploadFile as jest.Mock).mockImplementation(async (filePath: string) => ({
    cid: `cid-${filePath.split('/').pop()}`,
  }));
});

function makeSvc(): CoverArtService {
  return new CoverArtService();
}

const mockFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'coverArt',
    originalname: 'cover.jpg',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('fake-image-bytes'),
    size: 1024,
    ...overrides,
  }) as Express.Multer.File;

describe('CoverArtService.uploadCoverArt', () => {
  it('throws 404 when the song does not exist', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(null);

    const svc = makeSvc();
    await expect(svc.uploadCoverArt('ghost', 'user-1', mockFile())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws 403 when the caller is not the song owner', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({ id: 's1', artistId: 'owner-1' });

    const svc = makeSvc();
    await expect(svc.uploadCoverArt('s1', 'intruder', mockFile())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(PinataService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects unsupported image formats', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({ id: 's1', artistId: 'user-1' });

    const svc = makeSvc();
    await expect(
      svc.uploadCoverArt('s1', 'user-1', mockFile({ mimetype: 'image/gif' })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(PinataService.uploadFile).not.toHaveBeenCalled();
  });

  it('pins the original and three thumbnails, then saves the song', async () => {
    const song: any = { id: 's1', artistId: 'user-1', coverArtPath: 'old-url' };
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockSongRepo.save.mockImplementation(async (s: Song) => s);

    const svc = makeSvc();
    const result = await svc.uploadCoverArt('s1', 'user-1', mockFile());

    // Original + 3 thumbnail variants pinned.
    expect(PinataService.uploadFile).toHaveBeenCalledTimes(4);

    expect(song.coverArtIpfsHash).toMatch(/^cid-/);
    expect(song.coverArtThumbnails).toEqual(
      expect.objectContaining({
        '150': expect.any(String),
        '300': expect.any(String),
        '600': expect.any(String),
      }),
    );
    expect(song.coverArtPath).toContain('/ipfs/');
    expect(mockSongRepo.save).toHaveBeenCalledWith(song);
    expect(result.coverArtIpfsHash).toBe(song.coverArtIpfsHash);
  });

  it('clears the cache and deletes the previous S3 cover when replacing', async () => {
    const song: any = {
      id: 's1',
      artistId: 'user-1',
      coverArtPath: 'https://b.s3.amazonaws.com/covers/old.png',
    };
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockSongRepo.save.mockImplementation(async (s: Song) => s);

    await makeSvc().uploadCoverArt(
      's1',
      'user-1',
      mockFile({
        mimetype: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      }),
    );

    expect(CacheService.clearSong).toHaveBeenCalledWith('s1');
    expect(deleteS3Objects).toHaveBeenCalledWith(['covers/old.png']);
  });

  it('accepts png and webp uploads', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({ id: 's1', artistId: 'user-1' });
    mockSongRepo.save.mockImplementation(async (s: Song) => s);

    const svc = makeSvc();
    await svc.uploadCoverArt('s1', 'user-1', mockFile({ mimetype: 'image/webp' }));
    await svc.uploadCoverArt('s1', 'user-1', mockFile({ mimetype: 'image/png' }));

    // 2 uploads x 4 pins each.
    expect(PinataService.uploadFile).toHaveBeenCalledTimes(8);
  });
});

describe('CoverArtService.getCoverArt', () => {
  it('returns cover art URLs including thumbnails', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({
      id: 's1',
      coverArtPath: 'https://gateway/ipfs/cid-main',
      coverArtIpfsHash: 'cid-main',
      coverArtThumbnails: { '150': 'https://gateway/ipfs/cid-150' },
    });

    const svc = makeSvc();
    const result = await svc.getCoverArt('s1');

    expect(result).toEqual({
      songId: 's1',
      coverArtPath: 'https://gateway/ipfs/cid-main',
      coverArtIpfsHash: 'cid-main',
      thumbnails: { '150': 'https://gateway/ipfs/cid-150' },
    });
  });

  it('returns nulls when a song has no cover art yet', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({ id: 's1' });

    const svc = makeSvc();
    const result = await svc.getCoverArt('s1');

    expect(result.coverArtIpfsHash).toBeNull();
    expect(result.thumbnails).toBeNull();
  });

  it('throws 404 when the song does not exist', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(null);

    const svc = makeSvc();
    await expect(svc.getCoverArt('ghost')).rejects.toMatchObject({ statusCode: 404 });
  });
});
