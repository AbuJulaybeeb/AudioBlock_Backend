import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../CacheService', () => ({
  CacheService: { clearSong: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import AppDataSource from '../../config/db';
import { SongVersionService } from '../Song/SongVersionService';
import { Song } from '../../entities/Song';
import { SongVersion } from '../../entities/SongVersion';
import { UserRole } from '../../entities/User';
import { AppError } from '../../errors/AppError';

const mockSongRepo = {
  findOneBy: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
};

const mockVersionRepo = {
  count: jest.fn(),
  create: jest.fn((v: Partial<SongVersion>) => v as SongVersion),
  save: jest.fn(async (v: SongVersion) => v),
  find: jest.fn(),
  findAndCount: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
};

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 'song-1',
    artistId: 'artist-1',
    title: 'Original title',
    description: 'desc',
    genre: 'afrobeats',
    composers: 'composer',
    coverArtPath: 'cover.png',
    s3OriginalUrl: 's3://old.mp3',
    ipfsCid: 'cid-old',
    status: 'ready',
    ...overrides,
  } as Song;
}

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => {
    if (entity === Song) return mockSongRepo;
    if (entity === SongVersion) return mockVersionRepo;
    return mockSongRepo;
  });
});

describe('SongVersionService.createInitialVersion', () => {
  it('records version 1 as the active version', async () => {
    mockVersionRepo.count.mockResolvedValue(0);
    const song = makeSong();

    const version = await new SongVersionService().createInitialVersion(song, 'artist-1');

    expect(version.versionNumber).toBe(1);
    expect(version.isActive).toBe(true);
    expect(version.songId).toBe('song-1');
    expect(version.ipfsCid).toBe('cid-old');
    expect(mockVersionRepo.save).toHaveBeenCalled();
  });

  it('refuses to create a second initial version', async () => {
    mockVersionRepo.count.mockResolvedValue(1);

    await expect(
      new SongVersionService().createInitialVersion(makeSong(), 'artist-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('SongVersionService.createVersionFromReupload', () => {
  it('increments the version number and deactivates prior versions', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.count.mockResolvedValue(1);
    mockVersionRepo.findOne.mockResolvedValue({ versionNumber: 2 } as SongVersion);

    const version = await new SongVersionService().createVersionFromReupload('song-1', 'artist-1', {
      s3OriginalUrl: 's3://new.mp3',
      ipfsCid: 'cid-new',
      changeNote: 'remastered',
    });

    expect(version.versionNumber).toBe(3);
    expect(version.isActive).toBe(true);
    expect(version.status).toBe('processing');
    expect(version.ipfsCid).toBe('cid-new');
    expect(mockVersionRepo.update).toHaveBeenCalledWith(
      { songId: 'song-1', isActive: true },
      { isActive: false },
    );
  });

  it('backfills version 1 for songs uploaded before versioning existed', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.count.mockResolvedValue(0);
    mockVersionRepo.findOne.mockResolvedValue({ versionNumber: 1 } as SongVersion);

    const version = await new SongVersionService().createVersionFromReupload('song-1', 'artist-1', {
      s3OriginalUrl: 's3://new.mp3',
    });

    // Version 1 captures the pre-existing audio, the re-upload becomes 2.
    expect(mockVersionRepo.save).toHaveBeenCalledTimes(2);
    expect(version.versionNumber).toBe(2);
  });

  it('carries unchanged metadata over from the parent song', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.count.mockResolvedValue(1);
    mockVersionRepo.findOne.mockResolvedValue({ versionNumber: 1 } as SongVersion);

    const version = await new SongVersionService().createVersionFromReupload('song-1', 'artist-1', {
      title: 'New title',
    });

    expect(version.title).toBe('New title');
    expect(version.genre).toBe('afrobeats');
    expect(version.composers).toBe('composer');
  });

  it('rejects a re-upload by a non-owner', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong({ artistId: 'someone-else' }));

    await expect(
      new SongVersionService().createVersionFromReupload('song-1', 'artist-1', {}),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a re-upload for a missing song', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(null);

    await expect(
      new SongVersionService().createVersionFromReupload('nope', 'artist-1', {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('SongVersionService reads', () => {
  it('lists versions newest first', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.findAndCount.mockResolvedValue([
      [{ versionNumber: 2 }, { versionNumber: 1 }],
      2,
    ]);

    const result = await new SongVersionService().listVersions('song-1');

    expect(result.versions).toHaveLength(2);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(mockVersionRepo.findAndCount).toHaveBeenCalledWith({
      where: { songId: 'song-1' },
      order: { versionNumber: 'DESC' },
      skip: 0,
      take: 20,
    });
  });

  it('lets only the owner or an admin view version history', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    const svc = new SongVersionService();

    await expect(svc.assertCanViewHistory('song-1', { id: 'artist-1' })).resolves.toBeUndefined();
    await expect(
      svc.assertCanViewHistory('song-1', { id: 'admin-1', role: UserRole.ADMIN }),
    ).resolves.toBeUndefined();
    await expect(svc.assertCanViewHistory('song-1', { id: 'intruder' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('returns a specific version', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.findOne.mockResolvedValue({ versionNumber: 2, ipfsCid: 'cid-2' });

    const version = await new SongVersionService().getVersion('song-1', 2);

    expect(version.ipfsCid).toBe('cid-2');
  });

  it('404s for a version that does not exist', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockVersionRepo.findOne.mockResolvedValue(null);

    await expect(new SongVersionService().getVersion('song-1', 9)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('400s for a non-positive version number', async () => {
    await expect(new SongVersionService().getVersion('song-1', 0)).rejects.toBeInstanceOf(AppError);
  });
});

describe('SongVersionService.syncActiveVersion', () => {
  it('writes processing results onto the active version', async () => {
    mockVersionRepo.findOne.mockResolvedValue({
      versionNumber: 2,
      isActive: true,
      status: 'processing',
    } as SongVersion);

    const synced = await new SongVersionService().syncActiveVersion('song-1', {
      status: 'ready',
      hlsMasterUrl: 'https://cdn/master.m3u8',
      metadataCid: 'cid-meta',
    });

    expect(synced?.status).toBe('ready');
    expect(synced?.hlsMasterUrl).toBe('https://cdn/master.m3u8');
  });

  it('is a no-op when the song has no active version', async () => {
    mockVersionRepo.findOne.mockResolvedValue(null);

    const synced = await new SongVersionService().syncActiveVersion('song-1', { status: 'ready' });

    expect(synced).toBeNull();
    expect(mockVersionRepo.save).not.toHaveBeenCalled();
  });
});

describe('SongVersionService.rollbackVersion', () => {
  it('creates a new version copying target version metadata and promotes it to active', async () => {
    const song = makeSong({ title: 'Current Title v2' });
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockVersionRepo.findOne
      // getVersion fetches target version
      .mockResolvedValueOnce({
        versionNumber: 1,
        title: 'Original Title v1',
        description: 'Original Desc',
        genre: 'afrobeats',
        composers: 'Original Composer',
        coverArtPath: 'cover-v1.png',
        s3OriginalUrl: 's3://v1.mp3',
        hlsMasterUrl: 'https://cdn/v1/master.m3u8',
        ipfsCid: 'cid-v1',
        metadataCid: 'meta-v1',
        duration: 180,
        loudness: -14,
        status: 'ready',
      } as SongVersion)
      // getLatestVersionNumber fetches latest version
      .mockResolvedValueOnce({ versionNumber: 2 } as SongVersion);

    const rolledBack = await new SongVersionService().rollbackVersion(
      'song-1',
      1,
      'artist-1',
      'Restoring original mix',
    );

    expect(rolledBack.versionNumber).toBe(3);
    expect(rolledBack.isActive).toBe(true);
    expect(rolledBack.title).toBe('Original Title v1');
    expect(rolledBack.description).toBe('Original Desc');
    expect(rolledBack.changeNote).toBe('Restoring original mix');
    expect(rolledBack.status).toBe('ready');

    // Demoted prior active versions
    expect(mockVersionRepo.update).toHaveBeenCalledWith(
      { songId: 'song-1', isActive: true },
      { isActive: false },
    );

    // Parent song was updated with rolled-back fields
    expect(mockSongRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Original Title v1',
        description: 'Original Desc',
        status: 'ready',
      }),
    );
  });

  it('rejects rollback by a non-owner with 403', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong({ artistId: 'owner-id' }));

    await expect(
      new SongVersionService().rollbackVersion('song-1', 1, 'intruder-id'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects rollback for a non-existent song with 404', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(null);

    await expect(
      new SongVersionService().rollbackVersion('unknown-song', 1, 'artist-1'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
