import { createHmac } from 'crypto';

/**
 * Computes an anonymized listener key from an IP address and secret salt (Issue #793).
 * Uses HMAC-SHA256 to protect against rainbow table reversal of anonymous listener IPs.
 *
 * @param ip - Client IP address (defaults to 'unknown')
 * @param salt - Secret key salt (defaults to process.env.LISTENER_KEY_SALT)
 * @returns Hex-encoded HMAC-SHA256 digest
 */
export function generateListenerKey(ip?: string | null, salt?: string): string {
  const effectiveSalt = salt ?? process.env.LISTENER_KEY_SALT ?? '';
  const effectiveIp = ip ?? 'unknown';

  return createHmac('sha256', effectiveSalt).update(effectiveIp).digest('hex');
}
