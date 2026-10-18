/**
 * Authentication mode feature flag (Issue #636).
 *
 * The Privy migration has to coexist with the existing email/password and
 * wallet-signature auth rather than replace it in one deploy. A single boolean
 * is not enough to express that: "Privy on" and "legacy off" as one toggle
 * means a bad Privy release logs everybody out, and there is no way to run both
 * at once to compare before committing. So the mode is an explicit enum:
 *
 * | AUTH_MODE  | legacy `requireAuth` | Privy `requireAuth` | Intended use                    |
 * | ---------- | -------------------- | ------------------ | ------------------------------- |
 * | `legacy`   | yes                  | no                 | default / pre-migration / rollback |
 * | `both`     | yes                  | yes                | staged rollout + shadow testing  |
 * | `privy`    | no                   | yes                | after legacy signups have drained  |
 *
 * Defaults to `legacy` (fail-safe): with no `AUTH_MODE` set the behaviour is
 * byte-for-byte what it was before this flag existed.
 *
 * `PRIVY_ALLOW_LEGACY_FALLBACK` is a separate, narrower switch. It only governs
 * what happens when Privy itself is unreachable (Issue #635) — a transport
 * failure or an open circuit breaker — and never a genuine rejection such as a
 * bad signature or an expired token. Failing *closed* on a bad token is a
 * security property, so it is not negotiable by this flag.
 */

export type AuthMode = 'legacy' | 'privy' | 'both';

const AUTH_MODES: readonly AuthMode[] = ['legacy', 'privy', 'both'] as const;

/** The configured mode, normalised. Unrecognised values fail safe to `legacy`. */
export function getAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE || '').trim().toLowerCase();
  return (AUTH_MODES as readonly string[]).includes(raw) ? (raw as AuthMode) : 'legacy';
}

/** True when Privy access tokens may authenticate requests. */
export function isPrivyAuthEnabled(): boolean {
  return getAuthMode() !== 'legacy';
}

/**
 * True when the legacy JWT (`JWT_SECRET`-signed) path may authenticate
 * requests. Stays true in `both` mode so existing sessions keep working while
 * Privy ramps up.
 */
export function isLegacyAuthEnabled(): boolean {
  return getAuthMode() !== 'privy';
}

/**
 * Whether a Privy *infrastructure* failure may fall through to legacy auth.
 *
 * Only consulted after the Privy verifier reports an availability problem
 * (timeout, 5xx, open circuit), never after a definitive token rejection. If
 * this is off, a Privy outage surfaces as a 503 to the client rather than
 * silently accepting a lower-assurance credential.
 */
export function isLegacyFallbackEnabled(): boolean {
  return (process.env.PRIVY_ALLOW_LEGACY_FALLBACK || 'true').toLowerCase() === 'true';
}

/**
 * Whether the legacy EVM wallet-signature login and Dynamic Labs wallet routes
 * are reachable (Issue #809). Off unless `ENABLE_LEGACY_EVM_AUTH=true`.
 */
export function isLegacyEvmAuthEnabled(): boolean {
  return (process.env.ENABLE_LEGACY_EVM_AUTH || 'false').trim().toLowerCase() === 'true';
}

/** Whether Privy is usable at all — i.e. an app id is configured. */
export function isPrivyConfigured(): boolean {
  return Boolean((process.env.PRIVY_APP_ID || '').trim());
}

/**
 * Guard against an operator combination that cannot work: `privy` mode with no
 * `PRIVY_APP_ID` would reject every request with a 401 that looks like a client
 * bug. `isPrivyAuthEnabled()` already treats a missing app id as off, but the
 * misconfiguration is worth surfacing loudly at boot rather than as a stream of
 * puzzling 401s.
 *
 * @returns A warning string, or null when the configuration is coherent.
 */
export function checkAuthFlagConfig(): string | null {
  if (getAuthMode() !== 'legacy' && !isPrivyConfigured()) {
    return `AUTH_MODE=${getAuthMode()} but PRIVY_APP_ID is not set — Privy auth is disabled and no mode accepts Privy tokens. Set PRIVY_APP_ID or AUTH_MODE=legacy.`;
  }
  return null;
}

/** Current state of every auth flag, for an admin/status endpoint. */
export function listAuthFlags(): {
  mode: AuthMode;
  privyEnabled: boolean;
  legacyEnabled: boolean;
  legacyFallbackEnabled: boolean;
  privyConfigured: boolean;
} {
  return {
    mode: getAuthMode(),
    privyEnabled: isPrivyAuthEnabled(),
    legacyEnabled: isLegacyAuthEnabled(),
    legacyFallbackEnabled: isLegacyFallbackEnabled(),
    privyConfigured: isPrivyConfigured(),
  };
}
