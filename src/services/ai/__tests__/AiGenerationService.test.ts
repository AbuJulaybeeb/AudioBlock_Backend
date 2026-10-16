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
import { AiGenerationService } from '../AiGenerationService';
import { AiGenerationRecord } from '../../../entities/AiGenerationRecord';
import { Song } from '../../../entities/Song';
import { JobQueueService } from '../../JobQueueService';
import { FakeAiProvider, installFakeAi } from '../../../../tests/helpers/fakeAi';

const SONG_ID = 'song-1';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const RECORD_ID = 'record-1';

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
});

describe('AiGenerationService.requestGeneration', () => {
  it('rejects when the feature flag is disabled', async () => {
    const service = new AiGenerationService();

    await expect(service.requestGeneration('coverArt', SONG_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'AI_FEATURE_DISABLED',
    });
    expect(JobQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('rejects for a song the caller does not own', async () => {
    process.env.AI_FEATURE_COVER_ART_ENABLED = 'true';
    mockSongRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: OTHER_USER_ID, title: 'X' });
    const service = new AiGenerationService();

    await expect(service.requestGeneration('coverArt', SONG_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('creates a pending record and routes the job through JobQueueService', async () => {
    process.env.AI_FEATURE_DESCRIPTIONS_ENABLED = 'true';
    mockSongRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: USER_ID, title: 'X' });
    const service = new AiGenerationService();

    const record = await service.requestGeneration('descriptions', SONG_ID, USER_ID);

    expect(record.status).toBe('pending');
    expect(JobQueueService.enqueue).toHaveBeenCalledWith(
      'ai.generate_description',
      { recordId: RECORD_ID },
      { priority: 'low' },
    );
  });
});

describe('AiGenerationService.generate', () => {
  it('runs the configured provider and marks the record completed, then publishes a webhook', async () => {
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'coverArt',
      status: 'pending',
    });
    mockSongRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: USER_ID, title: 'My Song' });
    const service = new AiGenerationService();

    await service.generate('coverArt', RECORD_ID);

    expect(mockRecordRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        provider: 'fake',
        resultUrl: `https://fake-ai.test/cover/${SONG_ID}.png`,
      }),
    );
    expect(fakeProvider.callsTo('generateCoverArt')).toEqual([
      { songId: SONG_ID, title: 'My Song' },
    ]);
    expect(mockPublish).toHaveBeenCalledWith(
      'ai.generation.completed',
      expect.objectContaining({ recordId: RECORD_ID, status: 'completed', feature: 'coverArt' }),
    );
  });

  it('throws when the song backing the record has been deleted', async () => {
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'descriptions',
    });
    mockSongRepo.findOneBy.mockResolvedValue(null);
    const service = new AiGenerationService();

    await expect(service.generate('descriptions', RECORD_ID)).rejects.toThrow();
    expect(mockRecordRepo.save).not.toHaveBeenCalled();
  });
});

describe('AiGenerationService.markFailed', () => {
  it('marks the record failed and publishes a webhook event', async () => {
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'coverArt',
      status: 'pending',
    });
    const service = new AiGenerationService();

    await service.markFailed(RECORD_ID, 'provider unavailable');

    expect(mockRecordRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'provider unavailable' }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'ai.generation.completed',
      expect.objectContaining({ status: 'failed', errorMessage: 'provider unavailable' }),
    );
  });
});

describe('AiGenerationService lyric transcription (#285)', () => {
  const ownedSong = () => ({
    id: SONG_ID,
    artistId: USER_ID,
    title: 'My Song',
    s3OriginalUrl: 's3://raw/song-1.mp3',
  });

  beforeEach(() => {
    process.env.AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED = 'true';
  });

  it('is gated by its own feature flag', async () => {
    delete process.env.AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED;
    const service = new AiGenerationService();

    await expect(
      service.requestGeneration('lyricsTranscription', SONG_ID, USER_ID, { rightsConfirmed: true }),
    ).rejects.toMatchObject({ code: 'AI_FEATURE_DISABLED' });
  });

  it.each([undefined, false, 'true'])(
    'refuses to queue a transcription without an explicit rights confirmation (%p)',
    async (rightsConfirmed) => {
      mockSongRepo.findOneBy.mockResolvedValue(ownedSong());
      const service = new AiGenerationService();

      await expect(
        service.requestGeneration('lyricsTranscription', SONG_ID, USER_ID, {
          rightsConfirmed: rightsConfirmed as any,
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'LYRICS_RIGHTS_NOT_CONFIRMED' });
      expect(mockSongRepo.save).not.toHaveBeenCalled();
      expect(mockRecordRepo.save).not.toHaveBeenCalled();
      expect(JobQueueService.enqueue).not.toHaveBeenCalled();
    },
  );

  it('rejects songs whose audio is not available yet', async () => {
    mockSongRepo.findOneBy.mockResolvedValue({ ...ownedSong(), s3OriginalUrl: undefined });
    const service = new AiGenerationService();

    await expect(
      service.requestGeneration('lyricsTranscription', SONG_ID, USER_ID, { rightsConfirmed: true }),
    ).rejects.toMatchObject({ code: 'SONG_AUDIO_NOT_READY' });
    expect(JobQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('records the rights confirmation on the song, then queues the job', async () => {
    mockSongRepo.findOneBy.mockResolvedValue(ownedSong());
    const service = new AiGenerationService();

    await service.requestGeneration('lyricsTranscription', SONG_ID, USER_ID, {
      rightsConfirmed: true,
    });

    expect(mockSongRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        lyricsRightsConfirmedAt: expect.any(Date),
        lyricsRightsConfirmedBy: USER_ID,
      }),
    );
    expect(JobQueueService.enqueue).toHaveBeenCalledWith(
      'ai.transcribe_lyrics',
      { recordId: RECORD_ID },
      { priority: 'low' },
    );
    // The provider is never called on the request path — only by the job.
    expect(fakeProvider.calls).toHaveLength(0);
  });

  it('stores the transcription on the Song entity, not on the generation record', async () => {
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'lyricsTranscription',
      status: 'pending',
    });
    mockSongRepo.findOneBy.mockResolvedValue({
      ...ownedSong(),
      lyrics: 'Lyrics the artist typed in',
      lyricsRightsConfirmedAt: new Date(),
      lyricsRightsConfirmedBy: USER_ID,
    });
    fakeProvider.lyrics = '  Verse one\nChorus  ';
    const service = new AiGenerationService();

    await service.generate('lyricsTranscription', RECORD_ID);

    expect(fakeProvider.callsTo('transcribeLyrics')).toEqual([
      { songId: SONG_ID, title: 'My Song', audioUrl: 's3://raw/song-1.mp3', language: undefined },
    ]);
    expect(mockSongRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        aiLyricsTranscription: 'Verse one\nChorus',
        aiLyricsTranscribedAt: expect.any(Date),
        // Artist-entered lyrics are never overwritten by a transcription.
        lyrics: 'Lyrics the artist typed in',
      }),
    );
    const savedRecord = mockRecordRepo.save.mock.calls[0][0];
    expect(savedRecord).toMatchObject({ status: 'completed', provider: 'fake' });
    expect(savedRecord.resultText).toBeUndefined();
  });

  it('never calls the provider when the song has no rights confirmation', async () => {
    const record = {
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'lyricsTranscription',
      status: 'pending',
    };
    mockRecordRepo.findOneBy.mockResolvedValue(record);
    mockSongRepo.findOneBy.mockResolvedValue(ownedSong());
    const service = new AiGenerationService();

    await service.generate('lyricsTranscription', RECORD_ID);

    expect(fakeProvider.calls).toHaveLength(0);
    expect(mockSongRepo.save).not.toHaveBeenCalled();
    expect(mockRecordRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Lyric rights were not confirmed for this song',
      }),
    );
  });

  it('marks the record failed instead of storing an empty transcription', async () => {
    mockRecordRepo.findOneBy.mockResolvedValue({
      id: RECORD_ID,
      songId: SONG_ID,
      userId: USER_ID,
      feature: 'lyricsTranscription',
      status: 'pending',
    });
    mockSongRepo.findOneBy.mockResolvedValue({
      ...ownedSong(),
      lyricsRightsConfirmedAt: new Date(),
      lyricsRightsConfirmedBy: USER_ID,
    });
    fakeProvider.lyrics = '   ';
    const service = new AiGenerationService();

    await service.generate('lyricsTranscription', RECORD_ID);

    expect(mockSongRepo.save).not.toHaveBeenCalled();
    expect(mockRecordRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});
