import { isAiFeatureEnabled, aiFeatureEnvVar, listAiFeatureFlags } from '../aiFeatureFlags';

const ALL_ENV_VARS = [
  'AI_FEATURE_TAGS_ENABLED',
  'AI_FEATURE_DESCRIPTIONS_ENABLED',
  'AI_FEATURE_COVER_ART_ENABLED',
  'AI_FEATURE_MODERATION_TRIAGE_ENABLED',
  'AI_FEATURE_SEARCH_ENABLED',
  'AI_FEATURE_PLAYLISTS_ENABLED',
  'AI_FEATURE_TWEET_DRAFTS_ENABLED',
  'AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED',
];

describe('aiFeatureFlags', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ALL_ENV_VARS) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('defaults every feature to disabled', () => {
    for (const key of ALL_ENV_VARS) delete process.env[key];

    expect(listAiFeatureFlags()).toEqual({
      tags: false,
      descriptions: false,
      coverArt: false,
      moderationTriage: false,
      search: false,
      playlists: false,
      tweetDrafts: false,
      lyricsTranscription: false,
    });
  });

  it('enables only the feature whose flag is set to "true"', () => {
    process.env.AI_FEATURE_COVER_ART_ENABLED = 'true';

    expect(isAiFeatureEnabled('coverArt')).toBe(true);
    expect(isAiFeatureEnabled('descriptions')).toBe(false);
  });

  it('one feature failing closed does not disable the others', () => {
    process.env.AI_FEATURE_DESCRIPTIONS_ENABLED = 'true';
    process.env.AI_FEATURE_TAGS_ENABLED = 'garbage';

    expect(isAiFeatureEnabled('descriptions')).toBe(true);
    expect(isAiFeatureEnabled('tags')).toBe(false);
  });

  it('exposes the backing env var name for each feature', () => {
    expect(aiFeatureEnvVar('tweetDrafts')).toBe('AI_FEATURE_TWEET_DRAFTS_ENABLED');
    expect(aiFeatureEnvVar('lyricsTranscription')).toBe('AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED');
  });
});
