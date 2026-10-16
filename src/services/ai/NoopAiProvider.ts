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
} from './AiProvider';

/**
 * The always-available default provider (ADR-007, point 1): "a null/no-op
 * provider is always available so the platform runs fully without any AI
 * dependency." No network call is made and no user content leaves the
 * process — outputs are deterministic, rule-based templates, in the same
 * spirit as the other "AI-adjacent" features listed in docs/AI_FEATURES.md.
 *
 * This is what runs until a real vendor is wired up behind `AiProvider`.
 */
export class NoopAiProvider implements AiProvider {
  readonly name = 'noop';

  async generateCoverArt(input: CoverArtGenerationInput): Promise<CoverArtGenerationResult> {
    return {
      imageUrl: `ai://noop/cover-art/${input.songId}`,
      provider: this.name,
    };
  }

  async generateDescription(
    input: DescriptionGenerationInput,
  ): Promise<DescriptionGenerationResult> {
    const artist = input.artistName ? ` by ${input.artistName}` : '';
    const genre = input.genre ? ` in the ${input.genre} genre` : '';
    return {
      description: `"${input.title}"${artist} is a track${genre} on AudioBlock.`,
      provider: this.name,
    };
  }

  async draftTweet(input: TweetDraftInput): Promise<TweetDraftResult> {
    const url = input.releaseUrl ? ` ${input.releaseUrl}` : '';
    return {
      text: `${input.artistName} just released "${input.title}"! Listen now.${url}`,
      provider: this.name,
    };
  }

  /** Issue #273: Simple keyword-based scoring (no AI call) */
  async scoreContentReport(input: ContentModerationInput): Promise<ContentModerationResult> {
    // Rule-based scoring: check for high-severity keywords
    const text =
      `${input.contentText || ''} ${input.reportReason} ${input.reporterContext || ''}`.toLowerCase();

    const highSeverityKeywords = ['threat', 'violence', 'harm', 'suicide', 'illegal', 'child'];
    const mediumSeverityKeywords = ['spam', 'scam', 'fake', 'impersonation', 'harassment'];

    let severityScore = 25; // baseline
    const categories: string[] = [];

    for (const keyword of highSeverityKeywords) {
      if (text.includes(keyword)) {
        severityScore = Math.min(100, severityScore + 30);
        categories.push('high-severity-content');
      }
    }

    for (const keyword of mediumSeverityKeywords) {
      if (text.includes(keyword)) {
        severityScore = Math.min(100, severityScore + 15);
        categories.push(keyword);
      }
    }

    let suggestedPriority: 'low' | 'medium' | 'high' | 'critical';
    if (severityScore >= 80) suggestedPriority = 'critical';
    else if (severityScore >= 60) suggestedPriority = 'high';
    else if (severityScore >= 40) suggestedPriority = 'medium';
    else suggestedPriority = 'low';

    return {
      severityScore,
      suggestedPriority,
      categories: [...new Set(categories)],
      reasoning: 'Rule-based keyword matching (noop provider)',
      provider: this.name,
    };
  }

  /** Issue #274: Generate zero embeddings (semantic search disabled) */
  async embed(_input: EmbeddingInput): Promise<EmbeddingResult> {
    // Return a 384-dimensional zero vector (common embedding size)
    return {
      embedding: new Array(384).fill(0),
      model: 'noop-zero-embedding',
      provider: this.name,
    };
  }

  /**
   * Issue #285: The no-op provider cannot listen to audio, and inventing
   * lyrics would be worse than having none — so it returns an empty
   * transcription and the caller records the generation as failed.
   */
  async transcribeLyrics(input: LyricsTranscriptionInput): Promise<LyricsTranscriptionResult> {
    return { lyrics: '', language: input.language, provider: this.name };
  }
}
