/**
 * Jest setup (issue #287): AI tests never need a real provider API key.
 *
 * Runs before every test file. Known AI vendor credentials are removed from
 * the environment and AI_PROVIDER is pinned to the offline default, so a test
 * that only passes when a live key happens to be present on the developer's
 * machine fails locally exactly like it would in CI.
 *
 * Keep AI_PROVIDER_KEY_VARS in sync with scripts/check-ai-test-isolation.js.
 */
const AI_PROVIDER_KEY_VARS = [
  'AI_PROVIDER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'GROQ_API_KEY',
  'REPLICATE_API_TOKEN',
  'STABILITY_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'ASSEMBLYAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
];

for (const key of AI_PROVIDER_KEY_VARS) {
  delete process.env[key];
}
process.env.AI_PROVIDER = 'noop';

module.exports = { AI_PROVIDER_KEY_VARS };
