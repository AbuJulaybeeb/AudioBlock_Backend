# Testing Strategy: AI Features

AI features must never make live provider calls in tests. Live calls cost
money, give different output on every run, and need secrets that CI does not
and should not have (Issue #287).

## The rule

Every AI feature test runs against the **shared fake provider** in
[`tests/helpers/fakeAi.ts`](../tests/helpers/fakeAi.ts). Tests do not
hand-roll their own adapters, read provider API keys, or import vendor SDKs.

## The two fakes

The codebase has two AI entry points, and there is one fake for each:

| Layer | Used by | Fake | How to install |
| --- | --- | --- | --- |
| `AIProviderService` + `IAIAdapter` (`src/services/AI`) | `TagSuggestionService`, `PlaylistService` curation | `FakeAIAdapter` | `createFakeAIProviderService()` for constructor injection, or `installFakeAi()` for code that uses the `getAIProviderService()` singleton |
| `AiProvider` (`src/services/ai`) | `AiGenerationService` (cover art, descriptions, lyric transcription), `TweetDraftService`, `ReportService` triage | `FakeAiProvider` | `installFakeAi()`, which calls `setAiProviderForTests()` |

Both fakes:

- return deterministic output (`FakeAIAdapter.textResponse` and
  `FakeAiProvider.lyrics` can be set per test);
- record every call (`fake.calls`, `fake.callsTo('generateText')`);
- can simulate failure (`{ failWith: new Error('timeout') }`) or latency
  (`{ latencyMs: 200 }`), and track the peak number of concurrent calls
  (`maxInFlight`).

```ts
import { installFakeAi } from '../../../tests/helpers/fakeAi';

let fake: FakeAiProvider;
beforeEach(() => {
  fake = installFakeAi().provider;
});

it('stores the transcription', async () => {
  fake.lyrics = 'Verse one';
  await service.generate('lyricsTranscription', RECORD_ID);
  expect(fake.callsTo('transcribeLyrics')).toHaveLength(1);
});
```

```ts
import { createFakeAIProviderService } from '../../../tests/helpers/fakeAi';

const { service, adapter } = createFakeAIProviderService({
  textResponse: JSON.stringify({ genres: ['Jazz'], tags: ['smooth'] }),
});
const suggestions = new TagSuggestionService(service);
```

Because `installFakeAi()` replaces the process-wide providers, call it in
`beforeEach`. That way every test starts with a fresh fake and clean call
history.

## Guardrails

Two checks enforce the rule:

1. **Jest setup**: [`tests/setup/aiProviderIsolation.js`](../tests/setup/aiProviderIsolation.js)
   runs before every test file (`setupFiles` in `jest.config.js`). It removes
   known AI vendor credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...)
   from the environment and pins `AI_PROVIDER=noop`. A test that only passes
   because a real key happens to be set on a developer's machine fails
   locally, just as it would in CI.
2. **Static check**: `npm run ai:test-isolation`
   ([`scripts/check-ai-test-isolation.js`](../scripts/check-ai-test-isolation.js))
   runs in the CI `lint` job. It fails when:
   - `jest.config.js` stops loading the isolation setup file;
   - a test file references an AI vendor API key;
   - a test file imports a vendor AI SDK;
   - a test file defines its own AI double (`implements IAIAdapter`,
     `: AiProvider = { ... }`, `as IAIAdapter`, ...) instead of using the
     shared fakes;
   - `src/config/env.ts` makes an AI vendor key a required startup variable.

If a new vendor is added, add its key variable to `AI_PROVIDER_KEY_VARS` in
the setup file and its SDK package to `VENDOR_SDKS` in the check script.

## Adding a new AI feature

1. Add the method to the `AiProvider` interface (or reuse `IAIAdapter`).
2. Implement it in `NoopAiProvider` / `MockAIAdapter`, the offline defaults,
   **and** in the matching fake in `tests/helpers/fakeAi.ts`.
3. Write the feature's tests against the fake, using `installFakeAi()` or
   `createFakeAIProviderService()`.
4. Run `npm run ai:test-isolation` before pushing.

## Load testing

`npm run benchmark:ai` drives the AI abstraction with the same fakes under
concurrent load. See [AI_LOAD_TESTING.md](./AI_LOAD_TESTING.md).
