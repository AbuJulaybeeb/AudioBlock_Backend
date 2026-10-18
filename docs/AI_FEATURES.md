# AI Feature Set & Per-Artist Opt-In/Opt-Out

This document describes the current AI / ML-related feature surface of the
AudioBlock Backend, what data (if any) is sent where, and the mechanism for a
per-artist opt-in / opt-out.

> **Status (as of this doc):** the backend has **no live third-party AI / LLM /
> generative-AI integrations**. A codebase sweep for `openai`, `anthropic`,
> `claude`, `gemini`, `gpt`, `llm`, `stable-diffusion`, transcription, and
> related terms found no shipped integration that sends your data to an
> external AI provider. The "AI-adjacent" features below are deterministic,
> rule-based, or human-review driven — **none of them transmit song audio,
> lyrics, or user content to a machine-learning/LLM provider.**

---

## What "AI-adjacent" features exist today

None of the following call an LLM or generative model; they are deterministic
and run on either the node process or the SQL database.

### 1. Song cloud-streaming & manifest pre-computation

- **Where:** `src/workers/precomputeManifest.ts`, `SongController.stream`.
- **What it does:** transcodes audio (via `fluent-ffmpeg`) into HLS segments
  and pre-computes signed streaming manifests.
- **Data sent:** none to third parties — audio stays on S3 / IPFS, signing
  happens locally.

### 2. Moderation (flag / unflag, bulk actions)

- **Where:** `src/services/Song/SongModerationService.ts`, `ContentReport`,
  `TakedownRequest`, `AdminController`.
- **What it does:** human/admins **flag** a song for review (`flag`,
  `flag_for_review`, `approve`, `reject`), backed by `Song.flagged`,
  `flaggedAt`, `flaggedBy` and an audit log. Deterministic state transitions
  (no ML classification).
- **Data sent:** none to third parties; flags are stored locally.

### 3. Search

- **Where:** `SongService.searchSongs`.
- **What it does:** Postgres `pg_trgm` substring matching and similarity
  ranking for song lookup. Deterministic — **not** semantic/vector search, no
  embeddings.

### 4. Recommendations / discovery

- No collaborative-filtering or ML recommendation engine is present today.

### 5. Async AI-assisted generation (cover art, descriptions)

- **Where:** `src/services/ai/` (`AiProvider` interface, `NoopAiProvider`,
  `AiGenerationService`), `src/workers/AiJobHandlers.ts`,
  `POST /api/ai/songs/:songId/cover-art` and `/description`.
- **What it does:** these routes queue a generation job via `JobQueueService`
  instead of running it inline (cover art / description generation may be
  slow), and announce completion via the existing webhook system as
  `ai.generation.completed` (see `docs/WEBHOOK_IMPLEMENTATION_PLAN.md`).
  The provider actually called is `NoopAiProvider` — a deterministic,
  rule-based template, not a live model — until a real vendor is wired up
  behind the `AiProvider` interface per ADR-007.
- **Data sent:** none to third parties; the no-op provider makes no network
  call. Only the song title (no audio, lyrics, or files) is used to build the
  placeholder output, and only the generated output — never raw content — is
  persisted, in `ai_generation_records`.
- **Feature flags:** each AI feature is gated by its own env-var flag
  (`src/config/aiFeatureFlags.ts`) rather than one global `AI_ENABLED` switch,
  so a misbehaving feature can be disabled independently:
  `AI_FEATURE_TAGS_ENABLED`, `AI_FEATURE_DESCRIPTIONS_ENABLED`,
  `AI_FEATURE_COVER_ART_ENABLED`, `AI_FEATURE_MODERATION_TRIAGE_ENABLED`,
  `AI_FEATURE_SEARCH_ENABLED`, `AI_FEATURE_PLAYLISTS_ENABLED`,
  `AI_FEATURE_TWEET_DRAFTS_ENABLED`, `AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED`.
  All default OFF. `coverArt`, `descriptions`, `tweetDrafts`, and
  `lyricsTranscription` have a call site wired up today; the rest are reserved
  for when those features are built.

### 6. Release-announcement tweet drafts

- **Where:** `src/services/TweetDraftService.ts`,
  `POST /api/auth/twitter/draft`, `GET /api/auth/twitter/drafts`,
  `POST /api/auth/twitter/draft/:id/approve`,
  `DELETE /api/auth/twitter/draft/:id`.
- **What it does:** drafts announcement text for a release via the same
  `AiProvider` abstraction, stored as a `pending_review` `TweetDraft` for the
  artist to review. Approving a draft only marks it reviewed — AudioBlock
  does not post to Twitter on the artist's behalf, because `twitterRoutes.ts`
  deliberately never persists a Twitter access/refresh token (see the
  `/callback` handler there); the artist copies the approved text and posts
  it themselves.
- **Data sent:** none to third parties; gated by `AI_FEATURE_TWEET_DRAFTS_ENABLED`.

### 7. Opt-in, license-aware lyric transcription (Issue #285)

- **Where:** `AiGenerationService` (`lyricsTranscription` feature),
  `AiProvider.transcribeLyrics`, `src/workers/AiJobHandlers.ts`,
  `POST /api/ai/songs/:songId/lyrics-transcription` and
  `POST /api/ai-studio/songs/:songId/lyrics-transcription`.
- **Rights confirmation:** the request body must contain
  `{ "rightsConfirmed": true }` — the artist's explicit confirmation that they
  hold the rights to the song's lyrics. Anything else (missing, `false`,
  `"true"`) is rejected with `400 LYRICS_RIGHTS_NOT_CONFIRMED` before a record
  is created or a job is queued. The confirmation is stored on the song
  (`lyricsRightsConfirmedAt`, `lyricsRightsConfirmedBy`), and the job
  re-checks it — a job never calls the provider for a song whose confirmation
  is missing or was given by a different user.
- **Storage:** the transcription is written to `Song.aiLyricsTranscription`
  (with `aiLyricsTranscribedAt`), separate from artist-entered `Song.lyrics`,
  so a transcription never overwrites lyrics the artist typed. Following
  ADR-007, the `ai_generation_records` row only records that the job ran —
  the lyrics themselves are not copied into it.
- **Data sent:** the song's audio location, title and language hint go to the
  configured provider, and only after the rights confirmation. The default
  `NoopAiProvider` cannot transcribe audio: it returns an empty transcription
  and the record is marked `failed` rather than storing invented lyrics.
- **Feature flag:** `AI_FEATURE_LYRICS_TRANSCRIPTION_ENABLED` (default OFF).

### 8. Admin AI usage panel (Issue #289)

- **Where:** `GET /api/admin/ai/usage` (`AdminController.getAiUsage`,
  `src/services/ai/AiUsageService.ts`).
- **Access:** requires the `ai-usage:view` permission, granted to `admin` and
  `super_admin` only.
- **What it returns:** platform-wide totals plus usage aggregated **by
  feature** and **by artist** (completed / failed / pending counts and a
  per-feature breakdown per artist). Optional `from` / `to` ISO dates bound
  the window; `limit` caps the artist list (default 50, max 200) while
  `artistCount` still reports every artist that used AI.
- **Sources:** `ai_generation_records` (cover art, descriptions, lyric
  transcription) and `tweet_drafts`. Tag suggestions, playlist curation,
  moderation triage and semantic search do not persist a per-call record yet,
  so they do not appear in the panel.

---

## What data is sent to third-party providers (non-AI)

For completeness, the following outbound destinations exist — but they are
**storage / blockchain**, not AI analysis. None of these are model inference
endpoints and none receive prompts or generate content:

| Destination                                         | Purpose                   | Data sent                             | When                     |
| --------------------------------------------------- | ------------------------- | ------------------------------------- | ------------------------ |
| **Pinata / IPFS** (`src/services/PinataService.ts`) | Content-addressed storage | Audio files, cover art, metadata JSON | After upload / transcode |
| **AWS S3** (bucket `raw/`, `hls/`, `covers/`)       | Object storage            | Raw audio, HLS segments, covers       | During upload pipeline   |
| **Stellar / Soroban** (`src/config/soroban.ts`)     | On-chain metadata         | Minted song metadata / CIDs           | When minting             |
| **Dynamic Labs** (EVM)                              | Wallet-based auth         | Wallet address, signature nonces      | On login                 |

---

## Per-artist opt-in / opt-out

### What exists today (real mechanism)

There is **no AI-specific opt-in/opt-out toggle** in the code or database today
(because no AI features exist). The closest real, shipped control is the
**profile privacy toggle**:

- **Field:** `User.isProfilePublic` (boolean, default `true`).
- **Where:** `src/services/UserService.ts` (`updateProfile` with
  `isProfilePublic`; enforced in `getPublicProfile`, Issue #83).
- **Effect:** when `false`, public profile reads return
  `{ private: true }` — even the user's own profile fields are withheld from
  public endpoints. A privacy toggle intended to control how much a creator's
  content is exposed to derived/aggregated surfaces.

### Intended mechanism (design, not yet implemented)

The intended per-artist AI opt-in/opt-out, once any AI feature ships, should:

1. Be a **dedicated, default-`false` flag** (e.g. `User.aiFeatureOptIn`),
   separate from `isProfilePublic`, so visibility of a profile and inclusion in
   AI-derived features are orthogonal.
2. Be toggled by the artist only (`PATCH /api/artist/profile/settings`),
   one setting controlling **all** AI features at once (not per-feature).
3. When opted out, ensure no content is submitted to any AI/LLM provider and
   no derived outputs are generated.
4. Be enforceable server-side (a guard at the service layer), not just a UI
   switch.

Until an AI feature exists and this flag is implemented, the code contains only
the `isProfilePublic` privacy toggle described above.
