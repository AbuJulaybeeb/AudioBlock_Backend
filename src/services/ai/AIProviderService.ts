import logger from '../../config/logger';

/**
 * Interface options for text generation.
 * No vendor-specific types leak through this interface.
 */
export interface GenerateTextOptions {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Result structure for text generation.
 */
export interface GenerateTextResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Interface options for image generation.
 */
export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  n?: number;
}

/**
 * Result structure for image generation.
 */
export interface GenerateImageResult {
  images: Array<{
    url?: string;
    b64Json?: string;
  }>;
}

/**
 * Interface options for embedding generation.
 */
export interface EmbedOptions {
  text: string | string[];
  model?: string;
}

/**
 * Result structure for embedding generation.
 */
export interface EmbedResult {
  embeddings: number[][];
}

/**
 * Common adapter interface that all concrete AI provider adapters must implement.
 */
export interface IAIAdapter {
  readonly name: string;
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;
  generateImage(options: GenerateImageOptions): Promise<GenerateImageResult>;
  embed(options: EmbedOptions): Promise<EmbedResult>;
}

/**
 * Mock/Default AI Adapter providing deterministic responses for development,
 * testing, and offline environments without third-party vendor hardcoding.
 */
export class MockAIAdapter implements IAIAdapter {
  readonly name = 'mock';

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const prompt = options.prompt.toLowerCase();

    // Contextual responses for tags/genres suggestions
    if (prompt.includes('tag') || prompt.includes('genre') || prompt.includes('suggest')) {
      return {
        text: JSON.stringify({
          genres: ['Electronic', 'Ambient', 'Lo-Fi'],
          tags: ['chill', 'focus', 'instrumental', 'study', 'beats'],
        }),
        usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
      };
    }

    // Contextual responses for playlist curation
    if (prompt.includes('playlist') || prompt.includes('mood') || prompt.includes('curate')) {
      return {
        text: JSON.stringify({
          playlistName: 'AI Curated Mix',
          description: `Curated track selection based on: ${options.prompt}`,
          targetGenres: ['Lo-Fi', 'Ambient', 'Chillout', 'Electronic'],
          targetTags: ['chill', 'relax', 'focus', 'instrumental'],
        }),
        usage: { promptTokens: 30, completionTokens: 25, totalTokens: 55 },
      };
    }

    return {
      text: `Generated response for prompt: ${options.prompt}`,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    const count = options.n || 1;
    const images = Array.from({ length: count }, (_, idx) => ({
      url: `https://images.audioblock.io/mock-ai-generated-${idx + 1}.png`,
    }));
    return { images };
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const inputs = Array.isArray(options.text) ? options.text : [options.text];
    const embeddings = inputs.map((txt) => {
      // Deterministic 16-dimensional embedding based on string hash
      const vec: number[] = [];
      let hash = 0;
      for (let i = 0; i < txt.length; i++) {
        hash = (hash << 5) - hash + txt.charCodeAt(i);
        hash |= 0;
      }
      for (let j = 0; j < 16; j++) {
        vec.push(Math.sin(hash + j));
      }
      return vec;
    });

    return { embeddings };
  }
}

/**
 * Provider-agnostic AI abstraction layer (Issue #268).
 * Ensures business logic interacts only with this service, keeping caller sites
 * vendor-neutral and swappable via configuration.
 */
export class AIProviderService {
  private adapter: IAIAdapter;

  constructor(adapter?: IAIAdapter) {
    if (adapter) {
      this.adapter = adapter;
    } else {
      this.adapter = AIProviderService.resolveAdapterFromConfig();
    }
  }

  /**
   * Factory method to load an adapter based on environment configuration.
   */
  private static resolveAdapterFromConfig(): IAIAdapter {
    const providerName = (process.env.AI_PROVIDER || 'mock').toLowerCase();

    switch (providerName) {
      case 'mock':
      case 'noop':
      default:
        if (providerName !== 'mock' && providerName !== 'noop') {
          logger.warn(
            { providerName },
            'Unknown AI_PROVIDER specified in config; falling back to MockAIAdapter',
          );
        }
        return new MockAIAdapter();
    }
  }

  /**
   * Swap the underlying provider adapter at runtime.
   */
  setAdapter(adapter: IAIAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Get the current provider adapter.
   */
  getAdapter(): IAIAdapter {
    return this.adapter;
  }

  /**
   * Generate text using the configured AI adapter.
   */
  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    return this.adapter.generateText(options);
  }

  /**
   * Generate images using the configured AI adapter.
   */
  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    return this.adapter.generateImage(options);
  }

  /**
   * Generate embeddings using the configured AI adapter.
   */
  async embed(options: EmbedOptions): Promise<EmbedResult> {
    return this.adapter.embed(options);
  }
}

// Global default singleton
let defaultAiProviderService: AIProviderService | null = null;

export function getAIProviderService(): AIProviderService {
  if (!defaultAiProviderService) {
    defaultAiProviderService = new AIProviderService();
  }
  return defaultAiProviderService;
}

export function resetAIProviderService(): void {
  defaultAiProviderService = null;
}
