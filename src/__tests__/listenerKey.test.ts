import { createHmac } from 'crypto';
import { generateListenerKey } from '../utils/listenerKey';

describe('generateListenerKey (#793)', () => {
  const originalSalt = process.env.LISTENER_KEY_SALT;

  afterEach(() => {
    if (originalSalt !== undefined) {
      process.env.LISTENER_KEY_SALT = originalSalt;
    } else {
      delete process.env.LISTENER_KEY_SALT;
    }
  });

  it('generates consistent HMAC-SHA256 digest for an IP and salt', () => {
    const ip = '192.168.1.100';
    const salt = 'test-salt-secret-key-12345';
    const expected = createHmac('sha256', salt).update(ip).digest('hex');

    const result = generateListenerKey(ip, salt);
    expect(result).toBe(expected);
    expect(result).toHaveLength(64);
  });

  it('produces different hashes for different IPs with the same salt', () => {
    expect(generateListenerKey('1.1.1.1', 'salt')).not.toBe(generateListenerKey('8.8.8.8', 'salt'));
  });

  it('produces different hashes for the same IP with different salts', () => {
    expect(generateListenerKey('10.0.0.1', 'salt-a')).not.toBe(
      generateListenerKey('10.0.0.1', 'salt-b'),
    );
  });

  it('uses process.env.LISTENER_KEY_SALT when salt parameter is omitted', () => {
    process.env.LISTENER_KEY_SALT = 'env-configured-salt';
    const expected = createHmac('sha256', 'env-configured-salt').update('172.16.0.5').digest('hex');

    expect(generateListenerKey('172.16.0.5')).toBe(expected);
  });

  it('defaults to "unknown" when IP is null or undefined', () => {
    const expected = createHmac('sha256', 'salt').update('unknown').digest('hex');

    expect(generateListenerKey(null, 'salt')).toBe(expected);
    expect(generateListenerKey(undefined, 'salt')).toBe(expected);
  });
});
