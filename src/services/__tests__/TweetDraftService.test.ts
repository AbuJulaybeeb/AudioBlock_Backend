import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

import AppDataSource from '../../config/db';
import { TweetDraftService } from '../TweetDraftService';
import { TweetDraft } from '../../entities/TweetDraft';
import { Song } from '../../entities/Song';
import { User } from '../../entities/User';
import { FakeAiProvider, installFakeAi } from '../../../tests/helpers/fakeAi';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const SONG_ID = 'song-1';
const DRAFT_ID = 'draft-1';

const mockDraftRepo = {
  create: jest.fn((entity) => entity),
  save: jest.fn((entity) => Promise.resolve({ id: DRAFT_ID, ...entity })),
  find: jest.fn(),
  findOneBy: jest.fn(),
  remove: jest.fn(),
};

const mockSongRepo = { findOneBy: jest.fn() };
const mockUserRepo = { findOne: jest.fn() };
let fakeProvider: FakeAiProvider;

beforeEach(() => {
  jest.clearAllMocks();
  fakeProvider = installFakeAi().provider;
  delete process.env.AI_FEATURE_TWEET_DRAFTS_ENABLED;

  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
    if (entity === TweetDraft) return mockDraftRepo;
    if (entity === Song) return mockSongRepo;
    if (entity === User) return mockUserRepo;
    return {};
  });
});

describe('TweetDraftService.createDraft', () => {
  it('rejects when the tweetDrafts feature flag is disabled', async () => {
    const service = new TweetDraftService();

    await expect(service.createDraft(USER_ID, SONG_ID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'AI_FEATURE_DISABLED',
    });
  });

  it('rejects drafting for a song the caller does not own', async () => {
    process.env.AI_FEATURE_TWEET_DRAFTS_ENABLED = 'true';
    mockUserRepo.findOne.mockResolvedValue({ id: USER_ID, name: 'Artist' });
    mockSongRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: OTHER_USER_ID, title: 'X' });
    const service = new TweetDraftService();

    await expect(service.createDraft(USER_ID, SONG_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('creates a pending_review draft referencing the song title', async () => {
    process.env.AI_FEATURE_TWEET_DRAFTS_ENABLED = 'true';
    mockUserRepo.findOne.mockResolvedValue({ id: USER_ID, name: 'Cool Artist' });
    mockSongRepo.findOneBy.mockResolvedValue({
      id: SONG_ID,
      artistId: USER_ID,
      title: 'New Track',
    });
    const service = new TweetDraftService();

    const draft = await service.createDraft(USER_ID, SONG_ID);

    expect(draft.status).toBe('pending_review');
    expect(draft.text).toContain('New Track');
    expect(draft.text).toContain('Cool Artist');
    expect(draft.provider).toBe('fake');
    expect(fakeProvider.callsTo('draftTweet')).toHaveLength(1);
  });

  it('drafts without a specific song when none is given', async () => {
    process.env.AI_FEATURE_TWEET_DRAFTS_ENABLED = 'true';
    mockUserRepo.findOne.mockResolvedValue({ id: USER_ID, name: 'Cool Artist' });
    const service = new TweetDraftService();

    const draft = await service.createDraft(USER_ID);

    expect(mockSongRepo.findOneBy).not.toHaveBeenCalled();
    expect(draft.status).toBe('pending_review');
  });
});

describe('TweetDraftService.approveDraft / discardDraft', () => {
  it('approves a draft the caller owns', async () => {
    mockDraftRepo.findOneBy.mockResolvedValue({
      id: DRAFT_ID,
      userId: USER_ID,
      status: 'pending_review',
    });
    const service = new TweetDraftService();

    const approved = await service.approveDraft(USER_ID, DRAFT_ID);

    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it('refuses to approve a draft owned by a different user', async () => {
    mockDraftRepo.findOneBy.mockResolvedValue({ id: DRAFT_ID, userId: OTHER_USER_ID });
    const service = new TweetDraftService();

    await expect(service.approveDraft(USER_ID, DRAFT_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('discards a draft the caller owns', async () => {
    const draft = { id: DRAFT_ID, userId: USER_ID };
    mockDraftRepo.findOneBy.mockResolvedValue(draft);
    const service = new TweetDraftService();

    await service.discardDraft(USER_ID, DRAFT_ID);

    expect(mockDraftRepo.remove).toHaveBeenCalledWith(draft);
  });
});
