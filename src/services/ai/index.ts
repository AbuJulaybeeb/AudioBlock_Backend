import logger from '../../config/logger';
import { AiProvider } from './AiProvider';
import { NoopAiProvider } from './NoopAiProvider';

export * from './AiProvider';
export { NoopAiProvider };

let cachedProvider: AiProvider | null = null;

/**
 * Resolves the configured AI provider (`AI_PROVIDER` env var). No real vendor
 * is implemented yet (see ADR-007) — any value other than the default falls
 * back to the no-op provider with a warning, so misconfiguration never takes
 * the platform down.
 */
export function getAiProvider(): AiProvider {
  if (cachedProvider) return cachedProvider;

  const configured = (process.env.AI_PROVIDER || 'noop').toLowerCase();
  if (configured !== 'noop') {
    logger.warn(
      { configured },
      'AI_PROVIDER names a provider with no implementation yet; falling back to the no-op provider (see docs/adrs/007-ai-integration.md)',
    );
  }

  cachedProvider = new NoopAiProvider();
  return cachedProvider;
}

/**
 * Test-only: installs `provider` as the resolved provider so AI feature tests
 * run against a fake (see tests/helpers/fakeAi.ts) instead of a real vendor.
 */
export function setAiProviderForTests(provider: AiProvider): void {
  cachedProvider = provider;
}

/** Test-only: clears the cached provider so tests can re-resolve it. */
export function resetAiProviderForTests(): void {
  cachedProvider = null;
}
