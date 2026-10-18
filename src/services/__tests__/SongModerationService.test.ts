import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../CacheService', () => ({
  CacheService: { clearSong: jest.fn().mockResolvedValue(undefined) },
}));

const createLogEntry = jest.fn().mockResolvedValue(undefined);
jest.mock('../TransactionLogService', () => ({
  TransactionLogService: jest.fn().mockImplementation(() => ({ createLogEntry })),
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import AppDataSource from '../../config/db';
import { SongModerationService, BULK_MODERATION_MAX_BATCH } from '../Song/SongModerationService';
import { Song } from '../../entities/Song';

const mockSongRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(async (v: Song) => v),
};

function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    artistId: 'artist-1',
    status: 'ready',
    flagged: false,
    flaggedAt: null,
    flaggedBy: null,
    flagReason: null,
    errorReason: null,
    ...overrides,
  } as Song;
}

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockSongRepo);
});

describe('SongModerationService.bulkModerate validation', () => {
  it('rejects an unknown action', async () => {
    await expect(
      new SongModerationService().bulkModerate(['s1'], 'delete', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an empty batch', async () => {
    await expect(
      new SongModerationService().bulkModerate([], 'approve', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-array songIds value', async () => {
    await expect(
      new SongModerationService().bulkModerate('s1', 'approve', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects non-string song IDs', async () => {
    await expect(
      new SongModerationService().bulkModerate([1, 2], 'approve', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it(`rejects a batch larger than ${BULK_MODERATION_MAX_BATCH}`, async () => {
    const tooMany = Array.from({ length: BULK_MODERATION_MAX_BATCH + 1 }, (_, i) => `song-${i}`);

    await expect(
      new SongModerationService().bulkModerate(tooMany, 'approve', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BATCH_TOO_LARGE' });
  });

  it(`accepts a batch of exactly ${BULK_MODERATION_MAX_BATCH}`, async () => {
    const ids = Array.from({ length: BULK_MODERATION_MAX_BATCH }, (_, i) => `song-${i}`);
    mockSongRepo.find.mockResolvedValue(ids.map((id) => makeSong(id)));

    const result = await new SongModerationService().bulkModerate(ids, 'approve', 'admin-1');

    expect(result.requested).toBe(BULK_MODERATION_MAX_BATCH);
    expect(result.succeeded).toBe(BULK_MODERATION_MAX_BATCH);
  });

  it('de-duplicates repeated song IDs so each is moderated once', async () => {
    mockSongRepo.find.mockResolvedValue([makeSong('song-1')]);

    const result = await new SongModerationService().bulkModerate(
      ['song-1', 'song-1'],
      'flag_for_review',
      'admin-1',
    );

    expect(result.requested).toBe(1);
    expect(createLogEntry).toHaveBeenCalledTimes(1);
  });
});

describe('SongModerationService.bulkModerate actions', () => {
  it('approve clears flags', async () => {
    const song = makeSong('song-1', { flagged: true, flaggedBy: 'mod-1' });
    mockSongRepo.find.mockResolvedValue([song]);
    mockSongRepo.findOne.mockResolvedValue(song);

    const result = await new SongModerationService().bulkModerate(['song-1'], 'approve', 'admin-1');

    expect(result.results[0]).toMatchObject({ songId: 'song-1', success: true, flagged: false });
    expect(song.flagged).toBe(false);
  });

  it('approve fails for a song still processing', async () => {
    mockSongRepo.find.mockResolvedValue([makeSong('song-1', { status: 'processing' })]);

    const result = await new SongModerationService().bulkModerate(['song-1'], 'approve', 'admin-1');

    expect(result.succeeded).toBe(0);
    expect(result.results[0].reason).toMatch(/still processing/);
  });

  it('reject flags the song and marks it failed', async () => {
    const song = makeSong('song-1');
    mockSongRepo.find.mockResolvedValue([song]);

    const result = await new SongModerationService().bulkModerate(['song-1'], 'reject', 'admin-1');

    expect(result.results[0].success).toBe(true);
    expect(song.status).toBe('failed');
    expect(song.flagged).toBe(true);
    expect(song.flaggedBy).toBe('admin-1');
  });

  it('flag_for_review flags without changing processing status', async () => {
    const song = makeSong('song-1');
    mockSongRepo.find.mockResolvedValue([song]);

    await new SongModerationService().bulkModerate(['song-1'], 'flag_for_review', 'admin-1');

    expect(song.flagged).toBe(true);
    expect(song.status).toBe('ready');
    expect(song.flagReason).toMatch(/Flagged for review/);
  });

  it('reports per-song failures without aborting the batch', async () => {
    mockSongRepo.find.mockResolvedValue([makeSong('song-1')]);

    const result = await new SongModerationService().bulkModerate(
      ['song-1', 'missing-song'],
      'flag_for_review',
      'admin-1',
    );

    expect(result.requested).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.find((r) => r.songId === 'missing-song')).toMatchObject({
      success: false,
      reason: 'Song not found',
    });
  });

  it('writes one audit log entry per applied action', async () => {
    mockSongRepo.find.mockResolvedValue([makeSong('song-1'), makeSong('song-2')]);

    await new SongModerationService().bulkModerate(
      ['song-1', 'song-2'],
      'flag_for_review',
      'admin-7',
    );

    expect(createLogEntry).toHaveBeenCalledTimes(2);
    expect(createLogEntry).toHaveBeenCalledWith(
      'admin-7',
      '',
      'BULK_MODERATION_FLAG_FOR_REVIEW',
      expect.stringContaining('song-1'),
    );
  });

  it('does not audit-log a song that failed to moderate', async () => {
    mockSongRepo.find.mockResolvedValue([]);

    await new SongModerationService().bulkModerate(['missing'], 'reject', 'admin-1');

    expect(createLogEntry).not.toHaveBeenCalled();
  });
});
