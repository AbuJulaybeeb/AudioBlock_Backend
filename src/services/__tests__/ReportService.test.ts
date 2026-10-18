import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../CacheService', () => ({
  CacheService: { clearSong: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../TransactionLogService', () => ({
  TransactionLogService: jest.fn().mockImplementation(() => ({
    createLogEntry: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import AppDataSource from '../../config/db';
import { ReportService, REPORT_AUTO_FLAG_THRESHOLD } from '../ReportService';
import { Song } from '../../entities/Song';
import {
  ContentReport,
  ReportAction,
  ReportReason,
  ReportStatus,
} from '../../entities/ContentReport';
import { installFakeAi } from '../../../tests/helpers/fakeAi';

const mockReportRepo = {
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  findAndCount: jest.fn(),
  create: jest.fn((v: Partial<ContentReport>) => v as ContentReport),
  save: jest.fn(async (v: ContentReport) => v),
  count: jest.fn(),
};

const mockSongRepo = {
  findOneBy: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(async (v: Song) => v),
};

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 'song-1',
    artistId: 'artist-1',
    status: 'ready',
    flagged: false,
    flaggedAt: null,
    flaggedBy: null,
    flagReason: null,
    ...overrides,
  } as Song;
}

beforeEach(() => {
  // Report submission runs AI triage (#273) — keep it on the shared fake.
  installFakeAi();
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => {
    if (entity === ContentReport) return mockReportRepo;
    if (entity === Song) return mockSongRepo;
    return mockSongRepo;
  });
});

describe('ReportService.submitReport', () => {
  it('creates a pending report with a valid reason category', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockReportRepo.findOne.mockResolvedValue(null);
    mockReportRepo.count.mockResolvedValue(1);

    const result = await new ReportService().submitReport('song-1', 'user-1', {
      reason: 'copyright',
      description: '  uses my master  ',
    });

    expect(result.report.reason).toBe(ReportReason.COPYRIGHT);
    expect(result.report.status).toBe(ReportStatus.PENDING);
    expect(result.report.description).toBe('uses my master');
    expect(result.songFlagged).toBe(false);
  });

  it.each(['copyright', 'explicit', 'spam', 'other'])('accepts the %s category', async (reason) => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockReportRepo.findOne.mockResolvedValue(null);
    mockReportRepo.count.mockResolvedValue(1);

    const result = await new ReportService().submitReport('song-1', 'user-1', { reason });

    expect(result.report.reason).toBe(reason);
  });

  it('rejects an unknown reason category with a 400', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());

    await expect(
      new ReportService().submitReport('song-1', 'user-1', { reason: 'because' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a second report from the same user on the same song', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockReportRepo.findOne.mockResolvedValue({ id: 'existing' } as ContentReport);

    await expect(
      new ReportService().submitReport('song-1', 'user-1', { reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s when the reported song does not exist', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(null);

    await expect(
      new ReportService().submitReport('nope', 'user-1', { reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('auto-flags the song once pending reports reach the threshold', async () => {
    const song = makeSong();
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockReportRepo.findOne.mockResolvedValue(null);
    mockReportRepo.count.mockResolvedValue(REPORT_AUTO_FLAG_THRESHOLD);

    const result = await new ReportService().submitReport('song-1', 'user-3', { reason: 'spam' });

    expect(result.songFlagged).toBe(true);
    expect(song.flagged).toBe(true);
    expect(song.flagReason).toContain(String(REPORT_AUTO_FLAG_THRESHOLD));
  });

  it('does not re-flag a song that is already flagged', async () => {
    const song = makeSong({ flagged: true, flaggedBy: 'admin-1' });
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockReportRepo.findOne.mockResolvedValue(null);
    mockReportRepo.count.mockResolvedValue(REPORT_AUTO_FLAG_THRESHOLD + 5);

    const result = await new ReportService().submitReport('song-1', 'user-4', { reason: 'spam' });

    expect(result.songFlagged).toBe(false);
    expect(song.flaggedBy).toBe('admin-1');
  });
});

describe('ReportService.listPendingReports', () => {
  it('returns only pending reports, oldest first, with pagination', async () => {
    mockReportRepo.findAndCount.mockResolvedValue([[{ id: 'r1' }], 1]);

    const page = await new ReportService().listPendingReports(1, 20);

    expect(mockReportRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: ReportStatus.PENDING },
        order: { createdAt: 'ASC' },
        skip: 0,
        take: 20,
      }),
    );
    expect(page.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('caps the page size at 100', async () => {
    mockReportRepo.findAndCount.mockResolvedValue([[], 0]);

    await new ReportService().listPendingReports(2, 5000);

    expect(mockReportRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 100 }),
    );
  });
});

describe('ReportService.resolveReport', () => {
  it('marks the report resolved with the action taken', async () => {
    mockReportRepo.findOneBy.mockResolvedValue({
      id: 'r1',
      songId: 'song-1',
      status: ReportStatus.PENDING,
    } as ContentReport);
    mockSongRepo.findOneBy.mockResolvedValue(makeSong());
    mockReportRepo.count.mockResolvedValue(0);

    const report = await new ReportService().resolveReport('r1', 'mod-1', {
      actionTaken: 'dismissed',
      resolutionNote: 'not a violation',
    });

    expect(report.status).toBe(ReportStatus.RESOLVED);
    expect(report.actionTaken).toBe(ReportAction.DISMISSED);
    expect(report.resolvedBy).toBe('mod-1');
    expect(report.resolvedAt).toBeInstanceOf(Date);
  });

  it('flags the song when the action is song_flagged', async () => {
    const song = makeSong();
    mockReportRepo.findOneBy.mockResolvedValue({
      id: 'r1',
      songId: 'song-1',
      status: ReportStatus.PENDING,
    } as ContentReport);
    mockSongRepo.findOneBy.mockResolvedValue(song);

    await new ReportService().resolveReport('r1', 'mod-1', { actionTaken: 'song_flagged' });

    expect(song.flagged).toBe(true);
    expect(song.flaggedBy).toBe('mod-1');
  });

  it('lifts an auto-flag when the queue empties after a dismissal', async () => {
    const song = makeSong({ flagged: true, flaggedBy: null, flagReason: 'Auto-flagged' });
    mockReportRepo.findOneBy.mockResolvedValue({
      id: 'r1',
      songId: 'song-1',
      status: ReportStatus.PENDING,
    } as ContentReport);
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockSongRepo.findOne.mockResolvedValue(song);
    mockReportRepo.count.mockResolvedValue(0);

    await new ReportService().resolveReport('r1', 'mod-1', { actionTaken: 'dismissed' });

    expect(song.flagged).toBe(false);
  });

  it('keeps a moderator-set flag in place after a dismissal', async () => {
    const song = makeSong({ flagged: true, flaggedBy: 'admin-9' });
    mockReportRepo.findOneBy.mockResolvedValue({
      id: 'r1',
      songId: 'song-1',
      status: ReportStatus.PENDING,
    } as ContentReport);
    mockSongRepo.findOneBy.mockResolvedValue(song);
    mockReportRepo.count.mockResolvedValue(0);

    await new ReportService().resolveReport('r1', 'mod-1', { actionTaken: 'no_action' });

    expect(song.flagged).toBe(true);
  });

  it('rejects resolving an already-resolved report', async () => {
    mockReportRepo.findOneBy.mockResolvedValue({
      id: 'r1',
      songId: 'song-1',
      status: ReportStatus.RESOLVED,
    } as ContentReport);

    await expect(
      new ReportService().resolveReport('r1', 'mod-1', { actionTaken: 'dismissed' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an unknown resolution action', async () => {
    await expect(
      new ReportService().resolveReport('r1', 'mod-1', { actionTaken: 'nuke' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s for a report that does not exist', async () => {
    mockReportRepo.findOneBy.mockResolvedValue(null);

    await expect(
      new ReportService().resolveReport('nope', 'mod-1', { actionTaken: 'dismissed' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
