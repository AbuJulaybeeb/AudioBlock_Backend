import redis from '../../config/redis';
import logger from '../../config/logger';

type RevocationStore = Pick<typeof redis, 'get' | 'set'>;

/** Redis is authoritative; no negative cache can hide another instance's revocation. */
export class PrivySessionService {
  constructor(private readonly store: RevocationStore = redis) {}

  private async command<T>(operation: () => Promise<T>): Promise<T> {
    if (this.store === redis && redis.status !== 'ready')
      throw new Error('Privy revocation Redis is unavailable');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Privy revocation store timed out')), 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async revokeSession(sessionId: string, expiresAt: number): Promise<void> {
    if (!Number.isFinite(expiresAt)) throw new Error('Invalid session expiry');
    const ttl = Math.ceil(expiresAt - Date.now() / 1000);
    if (ttl <= 0) return;
    // Writes always surface errors: a successful logout must mean durable revocation.
    await this.command(() => this.store.set('privy:revoked:' + sessionId, '1', 'EX', ttl));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    // Retain the cutoff indefinitely: no maximum token lifetime is assumed.
    await this.command(() =>
      this.store.set('privy:revoked-user:' + userId, String(Date.now() / 1000)),
    );
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.revokeAllForUser(userId);
  }

  async isSessionRevoked(sessionId: string, userId?: string, issuedAt?: number): Promise<boolean> {
    try {
      const [session, cutoff] = await this.command(() =>
        Promise.all([
          this.store.get('privy:revoked:' + sessionId),
          userId ? this.store.get('privy:revoked-user:' + userId) : Promise.resolve(null),
        ]),
      );
      return (
        session !== null ||
        (cutoff !== null && (issuedAt === undefined || issuedAt < Number(cutoff)))
      );
    } catch (err) {
      const failOpen = process.env.PRIVY_REVOCATION_FAILURE_MODE === 'open';
      logger.error({ err, failOpen }, 'Privy revocation lookup failed');
      return !failOpen;
    }
  }

  async isRevoked(sessionId: string, userId?: string, issuedAt?: number): Promise<boolean> {
    return this.isSessionRevoked(sessionId, userId, issuedAt);
  }

  shutdown(): void {
    /* Redis lifecycle belongs to the application. */
  }
}

export const privySessionService = new PrivySessionService();
