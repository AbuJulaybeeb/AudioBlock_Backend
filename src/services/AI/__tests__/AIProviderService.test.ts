import { AIProviderService, MockAIAdapter } from '../AIProviderService';
import { FakeAIAdapter } from '../../../../tests/helpers/fakeAi';

describe('AIProviderService (Issue #268)', () => {
  it('should initialize with default MockAIAdapter when no adapter is provided', () => {
    const service = new AIProviderService();
    expect(service.getAdapter().name).toBe('mock');
  });

  it('should support swapping the adapter with zero caller changes', async () => {
    const service = new AIProviderService(new MockAIAdapter());
    expect(service.getAdapter().name).toBe('mock');

    const fakeAdapter = new FakeAIAdapter({
      textResponse: (options) => `Custom AI text response for: ${options.prompt}`,
    });
    service.setAdapter(fakeAdapter);
    expect(service.getAdapter().name).toBe('fake');

    const textResult = await service.generateText({ prompt: 'Test prompt' });
    expect(textResult.text).toBe('Custom AI text response for: Test prompt');
    expect(fakeAdapter.callsTo('generateText')).toEqual([{ prompt: 'Test prompt' }]);
  });

  it('should generate text without leaking vendor-specific types', async () => {
    const fakeAdapter = new FakeAIAdapter();
    const service = new AIProviderService(fakeAdapter);

    const result = await service.generateText({
      prompt: 'Summarize release',
      systemPrompt: 'You are an assistant',
      temperature: 0.7,
      maxTokens: 100,
    });

    expect(result).toHaveProperty('text');
    expect(typeof result.text).toBe('string');
    expect(result.usage?.totalTokens).toBe(2);
  });

  it('should generate images with the configured adapter', async () => {
    const fakeAdapter = new FakeAIAdapter();
    const service = new AIProviderService(fakeAdapter);

    const result = await service.generateImage({
      prompt: 'Cyberpunk album cover',
      size: '1024x1024',
      n: 1,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://fake-ai.test/image-1.png');
    expect(fakeAdapter.callsTo('generateImage')).toEqual([
      expect.objectContaining({ prompt: 'Cyberpunk album cover' }),
    ]);
  });

  it('should generate vector embeddings with the configured adapter', async () => {
    const fakeAdapter = new FakeAIAdapter();
    const service = new AIProviderService(fakeAdapter);

    const result = await service.embed({
      text: 'Ambient chillout soundscape',
    });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(['Ambient chillout soundscape'.length, 0.5, 0.25]);
    expect(fakeAdapter.callsTo('embed')).toEqual([{ text: 'Ambient chillout soundscape' }]);
  });

  it('MockAIAdapter should provide deterministic mock completions and embeddings', async () => {
    const mockAdapter = new MockAIAdapter();
    const service = new AIProviderService(mockAdapter);

    const tagResult = await service.generateText({ prompt: 'suggest tags for song' });
    const parsed = JSON.parse(tagResult.text);
    expect(Array.isArray(parsed.genres)).toBe(true);
    expect(Array.isArray(parsed.tags)).toBe(true);

    const embedResult = await service.embed({ text: 'Lo-Fi Chill Beats' });
    expect(embedResult.embeddings[0]).toHaveLength(16);

    const imgResult = await service.generateImage({ prompt: 'Electronic cover', n: 2 });
    expect(imgResult.images).toHaveLength(2);
  });
});
