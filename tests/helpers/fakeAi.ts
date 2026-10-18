/**
 * Shared AI test doubles (issue #287).
 *
 * AI feature tests must never reach a real provider: live calls cost money,
 * are flaky, and need secrets CI does not have. Every AI feature test uses
 * one of these fakes instead of hand-rolling its own adapter:
 *
 * - `FakeAIAdapter` implements `IAIAdapter` — install it on `AIProviderService`
 *   (TagSuggestionService, PlaylistService curation, ...).
 * - `FakeAiProvider` implements `AiProvider` — install it with
 *   `setAiProviderForTests` (AiGenerationService, TweetDraftService,
 *   ReportService triage, ...).
 *
 * Both record every call, return deterministic output, and can be told to
 * fail or to add latency (the latter is used by the concurrency benchmark in
 * scripts/load-test-ai-concurrency.ts). `scripts/check-ai-test-isolation.js`
 * fails CI if a test defines its own adapter/provider instead of using these.
 */
import {
  IAIAdapter,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateImageOptions,
  GenerateImageResult,
  EmbedOptions,
  EmbedResult,
  AIProviderService,
  getAIProviderService,
} from '../../src/services/AI/AIProviderService';
import {
  AiProvider,
  CoverArtGenerationInput,
  CoverArtGenerationResult,
  DescriptionGenerationInput,
  DescriptionGenerationResult,
  TweetDraftInput,
  TweetDraftResult,
  ContentModerationInput,
  ContentModerationResult,
  EmbeddingInput,
  EmbeddingResult,
  LyricsTranscriptionInput,
  LyricsTranscriptionResult,
} from '../../src/services/ai/AiProvider';
import { setAiProviderForTests } from '../../src/services/ai';

export interface FakeAiOptions {
  /** Fixed delay (ms) before every call resolves. Default 0. */
  latencyMs?: number;
  /** When set, every call rejects with this error. */
  failWith?: Error;
}

export interface FakeAiCall {
  method: string;
  input: unknown;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

abstract class FakeAiBase {
  /** Every call made, in order. */
  readonly calls: FakeAiCall[] = [];
  /** Calls currently awaiting a response — used to measure concurrency. */
  inFlight = 0;
  /** Highest `inFlight` value observed since construction / `reset()`. */
  maxInFlight = 0;

  constructor(protected options: FakeAiOptions = {}) {}

  /** Change latency/failure behaviour mid-test. */
  configure(options: FakeAiOptions): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.calls.length = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.input);
  }

  protected async run<T>(method: string, input: unknown, respond: () => T): Promise<T> {
    this.calls.push({ method, input });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.latencyMs) await sleep(this.options.latencyMs);
      if (this.options.failWith) throw this.options.failWith;
      return respond();
    } finally {
      this.inFlight--;
    }
  }
}

/** Fake for the adapter-based `AIProviderService` layer (src/services/AI). */
export class FakeAIAdapter extends FakeAiBase implements IAIAdapter {
  readonly name = 'fake';
  /** Text returned by `generateText`; a function receives the call's options. */
  textResponse: string | ((options: GenerateTextOptions) => string) = 'fake response';

  constructor(options: FakeAiOptions & { textResponse?: FakeAIAdapter['textResponse'] } = {}) {
    super(options);
    if (options.textResponse !== undefined) this.textResponse = options.textResponse;
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    return this.run('generateText', options, () => ({
      text:
        typeof this.textResponse === 'function' ? this.textResponse(options) : this.textResponse,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
  }

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    return this.run('generateImage', options, () => ({
      images: Array.from({ length: options.n || 1 }, (_, i) => ({
        url: `https://fake-ai.test/image-${i + 1}.png`,
      })),
    }));
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const inputs = Array.isArray(options.text) ? options.text : [options.text];
    return this.run('embed', options, () => ({
      embeddings: inputs.map((t) => [t.length, 0.5, 0.25]),
    }));
  }
}

/** Fake for the domain-level `AiProvider` interface (src/services/ai). */
export class FakeAiProvider extends FakeAiBase implements AiProvider {
  readonly name = 'fake';
  /** Lyrics returned by `transcribeLyrics`. */
  lyrics = 'fake transcribed lyrics';

  async generateCoverArt(input: CoverArtGenerationInput): Promise<CoverArtGenerationResult> {
    return this.run('generateCoverArt', input, () => ({
      imageUrl: `https://fake-ai.test/cover/${input.songId}.png`,
      provider: this.name,
    }));
  }

  async generateDescription(
    input: DescriptionGenerationInput,
  ): Promise<DescriptionGenerationResult> {
    return this.run('generateDescription', input, () => ({
      description: `Fake description for "${input.title}"`,
      provider: this.name,
    }));
  }

  async draftTweet(input: TweetDraftInput): Promise<TweetDraftResult> {
    return this.run('draftTweet', input, () => ({
      text: `${input.artistName} released "${input.title}"`,
      provider: this.name,
    }));
  }

  async scoreContentReport(input: ContentModerationInput): Promise<ContentModerationResult> {
    return this.run('scoreContentReport', input, () => ({
      severityScore: 50,
      suggestedPriority: 'medium' as const,
      categories: ['fake'],
      provider: this.name,
    }));
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    return this.run('embed', input, () => ({
      embedding: [input.text.length, 0.5, 0.25],
      model: 'fake-embedding',
      provider: this.name,
    }));
  }

  async transcribeLyrics(input: LyricsTranscriptionInput): Promise<LyricsTranscriptionResult> {
    return this.run('transcribeLyrics', input, () => ({
      lyrics: this.lyrics,
      language: input.language,
      provider: this.name,
    }));
  }
}

/** An `AIProviderService` wired to a fresh `FakeAIAdapter`. */
export function createFakeAIProviderService(
  options?: ConstructorParameters<typeof FakeAIAdapter>[0],
): { service: AIProviderService; adapter: FakeAIAdapter } {
  const adapter = new FakeAIAdapter(options);
  return { service: new AIProviderService(adapter), adapter };
}

/**
 * Installs fakes behind both global AI entry points — the
 * `getAIProviderService()` singleton and `getAiProvider()` — so code that
 * resolves its provider internally also hits the fake.
 */
export function installFakeAi(options: FakeAiOptions = {}): {
  adapter: FakeAIAdapter;
  provider: FakeAiProvider;
} {
  const adapter = new FakeAIAdapter(options);
  const provider = new FakeAiProvider(options);
  getAIProviderService().setAdapter(adapter);
  setAiProviderForTests(provider);
  return { adapter, provider };
}
