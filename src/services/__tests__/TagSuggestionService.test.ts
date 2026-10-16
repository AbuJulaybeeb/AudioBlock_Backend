import { TagSuggestionService } from '../TagSuggestionService';
import { createFakeAIProviderService } from '../../../tests/helpers/fakeAi';

describe('TagSuggestionService (Issue #270)', () => {
  it('should return AI-suggested tags and genres from title and description', async () => {
    const { service: aiService, adapter } = createFakeAIProviderService({
      textResponse: JSON.stringify({
        genres: ['Synthwave', 'Electronic'],
        tags: ['retro', '80s', 'neon', 'synthesizer'],
      }),
    });
    const suggestionService = new TagSuggestionService(aiService);

    const result = await suggestionService.suggestTagsAndGenres({
      title: 'Midnight Highway Drive',
      description: 'A nostalgic synthwave track with retro 80s analog synthesizers',
      artistName: 'Neon Rider',
    });

    expect(result.genres).toEqual(['Synthwave', 'Electronic']);
    expect(result.tags).toEqual(['retro', '80s', 'neon', 'synthesizer']);
    expect(adapter.callsTo('generateText')).toHaveLength(1);
  });

  it('should fall back silently with empty suggestions when AI provider throws an error', async () => {
    const { service: aiService } = createFakeAIProviderService({
      failWith: new Error('AI provider API timeout or 503 error'),
    });
    const suggestionService = new TagSuggestionService(aiService);

    // Should NOT throw an error, must fall back silently
    const result = await suggestionService.suggestTagsAndGenres({
      title: 'Broken Stream',
      description: 'Will fail gracefully',
    });

    expect(result).toEqual({ tags: [], genres: [] });
  });

  it('should return empty arrays when title is blank or missing', async () => {
    const { service: aiService, adapter } = createFakeAIProviderService();
    const suggestionService = new TagSuggestionService(aiService);

    const result = await suggestionService.suggestTagsAndGenres({
      title: '',
      description: 'No title provided',
    });

    expect(result).toEqual({ tags: [], genres: [] });
    expect(adapter.calls).toHaveLength(0);
  });

  it('should handle non-JSON responses gracefully with fallback extraction', async () => {
    const { service: aiService } = createFakeAIProviderService({
      textResponse:
        'Here are suggestions: ```json\n{"genres": ["Jazz", "Soul"], "tags": ["smooth", "horns"]}\n```',
    });
    const suggestionService = new TagSuggestionService(aiService);

    const result = await suggestionService.suggestTagsAndGenres({
      title: 'Autumn Jazz',
      description: 'Warm saxophone and piano',
    });

    expect(result.genres).toEqual(['Jazz', 'Soul']);
    expect(result.tags).toEqual(['smooth', 'horns']);
  });
});
