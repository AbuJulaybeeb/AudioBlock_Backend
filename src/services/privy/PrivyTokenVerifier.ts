/**
 * Verification of Privy-issued access tokens.
 *
 * A Privy access token is an ES256 JWT issued by `privy.io`, scoped to this
 * app, carrying the user's Privy identity id in `sub` and the session id in
 * `sid`. Verification is a two-step operation:
 *
 * 1. Read the `kid` header and resolve the matching public key (cached — see
 *    {@link PrivyJwksCache}, Issue #634).
 * 2. Check the signature and the claims against that key.
 *
 * The algorithm is pinned to ES256 rather than read from the token. Taking the
 * algorithm from the token is how JWT verification is subverted: an attacker
 * re-signs a token with the public key as an HMAC secret (`alg: HS256`) and a
 * verifier that trusts the header will happily accept it. `iss` and `aud` are
 * checked explicitly too, so a valid Privy token minted for a *different* app
 * cannot be replayed against this one.
 */

import jwt, { type JwtHeader, type JwtPayload, type VerifyOptions } from 'jsonwebtoken';
import { getPrivyConfig, PRIVY_TOKEN_ALGORITHM, PRIVY_TOKEN_ISSUER } from '../../config/privyAuth';
import { privyTokenVerificationsTotal } from '../MetricsService';
import {
  PrivyInvalidTokenError,
  PrivyMalformedTokenError,
  PrivySessionRevokedError,
} from './PrivyErrors';
import { getPrivyJwksCache, type PrivyJwksCache } from './PrivyJwksCache';
import { privySessionService } from './PrivySessionService';

/** Verified, normalised claims from a Privy access token. */
export interface VerifiedPrivyToken {
  /** Privy identity id (`did:privy:...`). Maps to a local user via `users.privyUserId`. */
  userId: string;
  /** Privy session id. Useful for revoking a single session rather than the user. */
  sessionId: string;
  /** `iss` claim. Always {@link PRIVY_TOKEN_ISSUER} for a token that got this far. */
  issuer: string;
  /** `aud` claim. Always this app's id for a token that got this far. */
  appId: string;
  /** Seconds since epoch. */
  issuedAt: number;
  /** Seconds since epoch. */
  expiresAt: number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrivyInvalidTokenError(`Privy token is missing the "${field}" claim`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PrivyInvalidTokenError(`Privy token has a malformed "${field}" claim`);
  }
  return value;
}

/**
 * Read a JWT header without verifying anything.
 *
 * Used only to pick which verifier and which cached key to use — the result is
 * never treated as authenticated. Throws {@link PrivyMalformedTokenError} for
 * anything that is not a three-part JWT.
 */
export function readJwtHeader(token: string): JwtHeader {
  if (typeof token !== 'string' || token.length === 0) {
    throw new PrivyMalformedTokenError('Token is empty');
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || !decoded.header) {
    throw new PrivyMalformedTokenError('Token is not a well-formed JWT');
  }

  return decoded.header;
}

/** Whether a bearer token looks like a Privy access token, by its `alg` header. */
export function looksLikePrivyToken(token: string): boolean {
  try {
    return readJwtHeader(token).alg === PRIVY_TOKEN_ALGORITHM;
  } catch {
    return false;
  }
}

/**
 * Verify a Privy access token and return its normalised claims.
 *
 * @param token - The raw bearer token.
 * @param cache - Injectable JWKS cache; defaults to the process-wide one.
 * @throws {PrivyMalformedTokenError} The token is not a JWT, or has no `kid`.
 * @throws {PrivyUnknownKeyError} No signing key matches the token's `kid`.
 * @throws {PrivyInvalidTokenError} Signature, issuer, audience, or expiry check failed.
 * @throws {PrivyKeyUnavailableError} Privy was unreachable and no key was cached.
 */
export async function verifyPrivyAccessToken(
  token: string,
  cache: PrivyJwksCache = getPrivyJwksCache(),
): Promise<VerifiedPrivyToken> {
  const config = getPrivyConfig();
  const header = readJwtHeader(token);

  // Reject a non-ES256 token before touching the key cache. The cache only ever
  // holds ES256 keys, so any other algorithm could not verify anyway; saying so
  // explicitly gives a clearer error and avoids a pointless JWKS fetch.
  if (header.alg !== PRIVY_TOKEN_ALGORITHM) {
    privyTokenVerificationsTotal.inc({ outcome: 'invalid' });
    throw new PrivyInvalidTokenError(
      `Privy tokens must be signed with ${PRIVY_TOKEN_ALGORITHM}, got "${String(header.alg)}"`,
    );
  }

  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    privyTokenVerificationsTotal.inc({ outcome: 'invalid' });
    throw new PrivyMalformedTokenError('Privy token is missing a key id (kid) header');
  }

  // `typ` is a header field. jsonwebtoken has no option to assert it (jose does),
  // so check it here: a token of another Privy flavour — an identity token, say —
  // carries different lifetime and audience semantics and must not be replayed
  // through the access-token path.
  if (header.typ && header.typ !== 'JWT') {
    privyTokenVerificationsTotal.inc({ outcome: 'invalid' });
    throw new PrivyInvalidTokenError(`Unexpected token type "${String(header.typ)}"`);
  }

  // Key resolution may raise PrivyKeyUnavailableError, which must not be
  // conflated with a bad token — it is what makes legacy fallback legitimate.
  const key = await cache.getKey(header.kid);

  const options: VerifyOptions = {
    // Pinned, never taken from the token — see the module comment on alg confusion.
    algorithms: [PRIVY_TOKEN_ALGORITHM],
    issuer: PRIVY_TOKEN_ISSUER,
    audience: config.appId,
  };

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, key, options) as JwtPayload;
  } catch (error) {
    privyTokenVerificationsTotal.inc({ outcome: 'invalid' });
    if (error instanceof jwt.TokenExpiredError) {
      throw new PrivyInvalidTokenError('Privy access token has expired');
    }
    throw new PrivyInvalidTokenError('Privy access token is invalid');
  }

  let result: VerifiedPrivyToken;
  try {
    result = {
      userId: requireString(payload.sub, 'sub'),
      sessionId: requireString(payload.sid, 'sid'),
      issuer: requireString(payload.iss, 'iss'),
      appId: requireString(payload.aud, 'aud'),
      issuedAt: requireNumber(payload.iat, 'iat'),
      expiresAt: requireNumber(payload.exp, 'exp'),
    };
  } catch (error) {
    privyTokenVerificationsTotal.inc({ outcome: 'invalid' });
    throw error;
  }

  // Check if the session has been explicitly revoked (Issue #625)
  if (
    await privySessionService.isSessionRevoked(result.sessionId, result.userId, result.issuedAt)
  ) {
    privyTokenVerificationsTotal.inc({ outcome: 'revoked' });
    throw new PrivySessionRevokedError(result.sessionId);
  }

  privyTokenVerificationsTotal.inc({ outcome: 'success' });
  return result;
}
