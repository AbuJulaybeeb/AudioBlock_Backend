import { sanitizeS3KeyPart, buildS3Key } from '../s3';

describe('sanitizeS3KeyPart', () => {
  it('accepts valid alphanumeric IDs', () => {
    expect(sanitizeS3KeyPart('user-123', 'userId')).toBe('user-123');
    expect(sanitizeS3KeyPart('song_456', 'songId')).toBe('song_456');
  });

  it('rejects path traversal attempts', () => {
    expect(() => sanitizeS3KeyPart('../etc/passwd', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('..%2F..%2F', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('foo/../../bar', 'userId')).toThrow();
  });

  it('rejects path separators', () => {
    expect(() => sanitizeS3KeyPart('foo/bar', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('foo\\bar', 'userId')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => sanitizeS3KeyPart('', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart(null as any, 'userId')).toThrow();
  });

  it('rejects special characters that could cause collisions', () => {
    expect(() => sanitizeS3KeyPart('user@id', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('user id', 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('user%id', 'userId')).toThrow();
  });

  it('rejects overly long values', () => {
    expect(() => sanitizeS3KeyPart('a'.repeat(129), 'userId')).toThrow();
    expect(() => sanitizeS3KeyPart('a'.repeat(128), 'userId')).toBe('a'.repeat(128));
  });
});

describe('buildS3Key', () => {
  it('builds a valid S3 key from sanitized parts', () => {
    expect(buildS3Key('songs', 'user-1', 'song-2', 'abc')).toBe('songs/user-1/song-2/abc');
  });

  it('rejects keys with path traversal in any part', () => {
    expect(() => buildS3Key('songs', '../etc', 'song-2')).toThrow();
    expect(() => buildS3Key('songs', 'user-1', '../../passwd')).toThrow();
  });

  it('rejects keys with special characters', () => {
    expect(() => buildS3Key('songs', 'user@id', 'song-2')).toThrow();
  });
});
