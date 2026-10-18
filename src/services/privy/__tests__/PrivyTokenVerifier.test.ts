jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { status: 'ready', get: jest.fn().mockResolvedValue(null) },
}));
import { generateKeyPairSync } from 'crypto';
import redis from '../../../config/redis';
import jwt from 'jsonwebtoken';
import { looksLikePrivyToken, readJwtHeader, verifyPrivyAccessToken } from '../PrivyTokenVerifier';
import { PrivyJwksCache } from '../PrivyJwksCache';
import {
  PrivyInvalidTokenError,
  PrivyKeyUnavailableError,
  PrivyMalformedTokenError,
  PrivyUnknownKeyError,
  isPrivyAvailabilityFailure,
} from '../PrivyErrors';

const APP_ID = 'test-app-id';
const DID = 'did:privy:abc123';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'ES256', use: 'sig' },
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    privateKey,
  };
}

function mint(
  pem: string,
  options: {
    kid?: string;
    audience?: string;
    issuer?: string;
    expiresIn?: number;
    typ?: string;
    omitSid?: boolean;
    subject?: string;
  } = {},
) {
  const payload: Record<string, unknown> = {
    sub: options.subject ?? DID,
    aud: options.audience ?? APP_ID,
    iss: options.issuer ?? 'privy.io',
  };
  if (!options.omitSid) payload.sid = 'sess_1';

  return jwt.sign(payload, pem, {
    algorithm: 'ES256',
    expiresIn: options.expiresIn ?? 3600,
    header: { typ: options.typ ?? 'JWT', alg: 'ES256', kid: options.kid ?? 'kid-1' },
  });
}

describe('PrivyTokenVerifier', () => {
  const originalEnv = { ...process.env };
  let cache: PrivyJwksCache;

  beforeEach(() => {
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_JWKS_TTL_MS = '60000';
    process.env.PRIVY_RETRY_ATTEMPTS = '1';
    process.env.JWT_SECRET = 'a-secret-for-tests';
  });

  afterEach(() => {
    for (const key of ['PRIVY_APP_ID', 'PRIVY_JWKS_TTL_MS', 'PRIVY_RETRY_ATTEMPTS', 'JWT_SECRET']) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  const buildCache = (keys: unknown[]) =>
    (cache = new PrivyJwksCache({ fetchJwks: jest.fn().mockResolvedValue({ keys }) as never }));

  describe('happy path', () => {
    it('verifies a well-formed token and returns normalised claims', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      const result = await verifyPrivyAccessToken(mint(pem), cache);

      expect(result).toEqual({
        userId: DID,
        sessionId: 'sess_1',
        issuer: 'privy.io',
        appId: APP_ID,
        issuedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });
    });
  });

  it('awaits Redis session and user revocation checks for verified claims', async () => {
    const { jwk, pem } = makeKeypair();
    buildCache([jwk]);
    jest
      .mocked(redis.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(String(Date.now() / 1000 + 1));
    await expect(verifyPrivyAccessToken(mint(pem), cache)).rejects.toMatchObject({
      name: 'PrivySessionRevokedError',
    });
    expect(redis.get).toHaveBeenCalledWith('privy:revoked:sess_1');
    expect(redis.get).toHaveBeenCalledWith('privy:revoked-user:' + DID);
  });

  describe('cryptographic and claim enforcement', () => {
    it('rejects a token signed by a different key, even with a known kid', async () => {
      // The classic JWKS pitfall: the kid matched but the signature did not.
      const { jwk } = makeKeypair();
      const impostor = makeKeypair();
      buildCache([jwk]);

      await expect(verifyPrivyAccessToken(mint(impostor.pem), cache)).rejects.toBeInstanceOf(
        PrivyInvalidTokenError,
      );
    });

    it('rejects a token minted for a different app', async () => {
      // A valid Privy token from app A must not be replayable against app B.
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(
        verifyPrivyAccessToken(mint(pem, { audience: 'some-other-app' }), cache),
      ).rejects.toBeInstanceOf(PrivyInvalidTokenError);
    });

    it('rejects a token from a different issuer', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(
        verifyPrivyAccessToken(mint(pem, { issuer: 'evil.example' }), cache),
      ).rejects.toBeInstanceOf(PrivyInvalidTokenError);
    });

    it('rejects an expired token', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(verifyPrivyAccessToken(mint(pem, { expiresIn: -60 }), cache)).rejects.toThrow(
        /expired/i,
      );
    });

    it('rejects a token with no sid claim', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(
        verifyPrivyAccessToken(mint(pem, { omitSid: true }), cache),
      ).rejects.toBeInstanceOf(PrivyInvalidTokenError);
    });

    it('rejects an unknown kid', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(
        verifyPrivyAccessToken(mint(pem, { kid: 'kid-unknown' }), cache),
      ).rejects.toBeInstanceOf(PrivyUnknownKeyError);
    });

    it('rejects a non-JWT typ so an identity token cannot be replayed as an access token', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      await expect(
        verifyPrivyAccessToken(mint(pem, { typ: 'identity' }), cache),
      ).rejects.toBeInstanceOf(PrivyInvalidTokenError);
    });
  });

  describe('algorithm confusion (the reason alg is pinned, not read)', () => {
    it('rejects an HS256 token signed with the public key', async () => {
      // The canonical JWT attack: take the public key, use it as an HMAC secret,
      // and set alg: HS256. A verifier that trusts the header accepts this.
      const { jwk, privateKey } = makeKeypair();
      buildCache([jwk]);
      const publicPem = createPublicKeyFromJwk(jwk);

      const forged = jwt.sign(
        { sub: DID, aud: APP_ID, iss: 'privy.io', sid: 'sess_1' },
        publicPem,
        { algorithm: 'HS256', header: { typ: 'JWT', alg: 'HS256', kid: 'kid-1' } },
      );

      await expect(verifyPrivyAccessToken(forged, cache)).rejects.toBeInstanceOf(
        PrivyInvalidTokenError,
      );
      expect(privateKey).toBeDefined();
    });

    it('rejects an alg:none token', async () => {
      const { jwk } = makeKeypair();
      buildCache([jwk]);

      const header = Buffer.from(
        JSON.stringify({ typ: 'JWT', alg: 'none', kid: 'kid-1' }),
      ).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({ sub: DID, aud: APP_ID, iss: 'privy.io', sid: 'sess_1', exp: 9999999999 }),
      ).toString('base64url');

      await expect(verifyPrivyAccessToken(`${header}.${body}.`, cache)).rejects.toBeInstanceOf(
        PrivyInvalidTokenError,
      );
    });
  });

  describe('malformed input', () => {
    it.each(['', 'not-a-jwt', 'a.b', 'a.b.c.d'])('rejects %p as malformed', async (token) => {
      buildCache([makeKeypair().jwk]);
      await expect(verifyPrivyAccessToken(token, cache)).rejects.toBeInstanceOf(
        PrivyMalformedTokenError,
      );
    });

    it('rejects a JWT that omits the kid header', async () => {
      const { jwk, pem } = makeKeypair();
      buildCache([jwk]);

      const noKid = jwt.sign({ sub: DID, aud: APP_ID, iss: 'privy.io', sid: 's' }, pem, {
        algorithm: 'ES256',
        header: { typ: 'JWT', alg: 'ES256' },
      });

      await expect(verifyPrivyAccessToken(noKid, cache)).rejects.toBeInstanceOf(
        PrivyMalformedTokenError,
      );
    });
  });

  describe('error classification drives the middleware fallback decision', () => {
    it('flags availability failures as retryable', () => {
      expect(isPrivyAvailabilityFailure(new PrivyKeyUnavailableError('down'))).toBe(true);
    });

    it.each([
      ['invalid', new PrivyInvalidTokenError('bad')],
      ['unknown key', new PrivyUnknownKeyError('no kid')],
      ['malformed', new PrivyMalformedTokenError('garbage')],
    ])('does NOT flag a %s rejection as an availability failure', (_label, error) => {
      // Fail-closed: anything not positively an outage must not open a bypass.
      expect(isPrivyAvailabilityFailure(error)).toBe(false);
    });
  });

  describe('header inspection', () => {
    it('identifies a Privy token by its ES256 header', () => {
      const { pem } = makeKeypair();
      expect(looksLikePrivyToken(mint(pem))).toBe(true);
    });

    it('does not mistake a legacy HS256 token for a Privy token', () => {
      const legacy = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET as string, {
        algorithm: 'HS256',
        expiresIn: 900,
      });
      expect(looksLikePrivyToken(legacy)).toBe(false);
    });

    it('returns false for garbage rather than throwing', () => {
      expect(looksLikePrivyToken('nonsense')).toBe(false);
      expect(looksLikePrivyToken('')).toBe(false);
    });

    it('reads the header without verifying', () => {
      const { pem } = makeKeypair();
      expect(readJwtHeader(mint(pem)).kid).toBe('kid-1');
    });
  });
});

/** Rebuild a PEM public key from a JWK, for the algorithm-confusion test. */
function createPublicKeyFromJwk(jwk: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey } = require('crypto');
  return createPublicKey({ key: jwk, format: 'jwk' })
    .export({ format: 'pem', type: 'spki' })
    .toString();
}
