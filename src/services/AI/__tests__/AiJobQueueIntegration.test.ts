/**
 * Integration test for the full AI job queue path (#296):
 * enqueue → worker processes → webhook callback fires with expected payload.
 *
 * Uses a mocked AI provider and the real AiGenerationService to exercise
 * the requestGeneration → generate → emitWebhook flow end-to-end.
 */

import 'reflect-metadata';

jest.mock('../../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

jest.mock('../../JobQueueService', () => ({
  JobQueueService: { enqueue: jest.fn() },
}));

const mockPublish = jest.fn();
jest.mock('../../WebhookService', () => ({
  WebhookService: jest.fn().mockImplementation(() => ({ publish: mockPublish })),
}));

import AppDataSource from '../../../config/db';
import { AiGenerationService, AI_JOB_TYPE } from '../AiGenerationService';
import { AiGenerationRecord } from '../../../entities/AiGenerationRecord';
import { Song } from '../../../entities/Song';
import { JobQueueService } from '../../JobQueueService';
import { FakeAiProvider, installFakeAi } from '../../../../tests/helpers/fakeAi';

const SONG_ID = 'song-int-1';
const USER_ID = 'user-int-1';
const RECORD_ID = 'record-int-1';

const mockRecordRepo = {
  create: jest.fn((entity) => entity),
  save: jest.fn((entity) => Promise.resolve({ id: RECORD_ID, ...entity })),
  findOneBy: jest.fn(),
};

const mockSongRepo = {
  findOneBy: jest.fn(),
  save: jest.fn((entity) => Promise.resolve(entity)),
};

let fakeProvider: FakeAiProvider;

beforeEach(() => {
  jest.clearAllMocks();
  fakeProvider = installFakeAi().provider;
  delete process.env.AI_FEATURE_COVER_ART_ENABLED;
  delete process.env.AI_FEATURE_DESCRIPTIONS_ENABLED;
  delete process.env.AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED;

  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
    if (entity === AiGenerationRecord) return mockRecordRepo;
    if (entity === Song) return mockSongRepo;
    return {};
  });

  mockSongRepo.findOneBy.mockResolvedValue({
    id: SONG_ID,
    artistId: USER_ID,
    title: 'Integration Test Song',
    s3OriginalUrl: 'https://example.com/audio.mp3',
    hlsMasterUrl: null,
  });

  mockRecordRepo.findOneBy.mockResolvedValue({
    id: RECORD_ID,
    songId: SONG_ID,
    userId: USER_ID,
    feature: 'coverArt',
    status: 'pending',
  });
});

describe('AI job queue integration (#296)', () => {
  it('enqueue → generate → webhook fires with completed payload', async () => {
    const service = new AiGenerationService();

    // 1. Enqueue
    const record = await service.requestGeneration('coverArt', SONG_ID, USER_ID);
    expect(record.status).toBe('pending');
    expect(JobQueueService.enqueue).toHaveBeenCalledWith(
      AI_JOB_TYPE.coverArt,
      { recordId: RECORD_ID },
      { priority: 'low' },
    );

    // 2. Simulate worker processing the job
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'coverArt',
      status: 'pending',
    });
    await service.generate('coverArt', RECORD_ID);

    // 3. Assert webhook fired with expected payload
    expect(mockPublish).toHaveBeenCalledWith('ai.generation.completed', {
      recordId: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'coverArt',
      status: 'completed',
      resultText: undefined,
      resultUrl: fakeProvider.lastCoverArtResult?.imageUrl ?? expect.any(String),
      errorMessage: undefined,
    });
  });

  it('enqueue → generate (description) → webhook fires with resultText', async () => {
    const service = new AiGenerationService();

    await service.requestGeneration('descriptions', SONG_ID, USER_ID);

    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'descriptions',
      status: 'pending',
    });
    await service.generate('descriptions', RECORD_ID);

    expect(mockPublish).toHaveBeenCalledWith(
      'ai.generation.completed',
      expect.objectContaining({
        feature: 'descriptions',
        status: 'completed',
        resultText: expect.any(String),
      }),
    );
  });

  it('enqueue → generate (lyrics) → webhook fires after rights confirmation', async () => {
    process.env.AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED = 'true';
    const service = new AiGenerationService();

    mockSongRepo.findOneBy.mockResolvedValue({
      id: SONG_ID,
      artistId: USER_ID,
      title: 'Integration Test Song',
      s3OriginalUrl: 'https://example.com/audio.mp3',
      hlsMasterUrl: null,
    });

    await service.requestGeneration('lyricsTranscription', SONG_ID, USER_ID, {
      rightsConfirmed: true,
    });

    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'lyricsTranscription',
      status: 'pending',
    });
    mockSongRepo.findOneBy.mockResolvedValue({
      id: SONG_ID,
      artistId: USER_ID,
      title: 'Integration Test Song',
      s3OriginalUrl: 'https://example.com/audio.mp3',
      hlsMasterUrl: null,
      lyricsRightsConfirmedAt: new Date(),
      lyricsRightsConfirmedBy: USER_ID,
      language: null,
    });

    await service.generate('lyricsTranscription', RECORD_ID);

    expect(mockPublish).toHaveBeenCalledWith(
      'ai.generation.completed',
      expect.objectContaining({
        feature: 'lyricsTranscription',
        status: 'completed',
      }),
    );
  });

  it('markFailed fires webhook with failed status', async () => {
    const service = new AiGenerationService();

    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'coverArt',
      status: 'pending',
    });

    await service.markFailed(RECORD_ID, 'Provider unavailable');

    expect(mockPublish).toHaveBeenCalledWith(
      'ai.generation.completed',
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Provider unavailable',
      }),
    );
  });
});
