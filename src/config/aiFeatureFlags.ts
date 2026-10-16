/**
 * Per-feature AI kill switches (ADR-007: docs/adrs/007-ai-integration.md).
 *
 * A single global `AI_ENABLED` flag is too coarse: if one AI feature
 * misbehaves (bad output, runaway cost, a provider incident) there is no way
 * to disable it without also disabling every other AI feature. Each AI call
 * site instead checks its own flag here.
 *
 * All flags default OFF (fail closed) — a feature must be explicitly enabled
 * via its env var before it calls into the AI provider abstraction
 * (`src/services/ai`).
 */

export type AiFeature =
  | 'tags'
  | 'descriptions'
  | 'coverArt'
  | 'moderationTriage'
  | 'search'
  | 'playlists'
  | 'tweetDrafts'
  | 'lyricsTranscription';

const FEATURE_ENV_VAR: Record<AiFeature, string> = {
  tags: 'AI_FEATURE_TAGS_ENABLED',
  descriptions: 'AI_FEATURE_DESCRIPTIONS_ENABLED',
  coverArt: 'AI_FEATURE_COVER_ART_ENABLED',
  moderationTriage: 'AI_FEATURE_MODERATION_TRIAGE_ENABLED',
  search: 'AI_FEATURE_SEARCH_ENABLED',
  playlists: 'AI_FEATURE_PLAYLISTS_ENABLED',
  tweetDrafts: 'AI_FEATURE_TWEET_DRAFTS_ENABLED',
  lyricsTranscription: 'AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED',
};

/** Whether `feature` is enabled. Checked at each AI call site. */
export function isAiFeatureEnabled(feature: AiFeature): boolean {
  return (process.env[FEATURE_ENV_VAR[feature]] || '').toLowerCase() === 'true';
}

/** The env var name backing `feature`'s flag, for error messages/docs. */
export function aiFeatureEnvVar(feature: AiFeature): string {
  return FEATURE_ENV_VAR[feature];
}

/** Current on/off state of every AI feature flag, e.g. for an admin/status endpoint. */
export function listAiFeatureFlags(): Record<AiFeature, boolean> {
  return (Object.keys(FEATURE_ENV_VAR) as AiFeature[]).reduce(
    (acc, feature) => {
      acc[feature] = isAiFeatureEnabled(feature);
      return acc;
    },
    {} as Record<AiFeature, boolean>,
  );
}
