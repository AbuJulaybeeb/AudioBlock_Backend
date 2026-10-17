import { sniffContentType, validateFileContent } from '../contentSniffing';

describe('sniffContentType', () => {
  it('detects JPEG from magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(sniffContentType(buf)).toBe('image/jpeg');
  });

  it('detects PNG from magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffContentType(buf)).toBe('image/png');
  });

  it('detects WebP from RIFF+WEBP magic', () => {
    const buf = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffContentType(buf)).toBe('image/webp');
  });

  it('returns null for unrecognized content', () => {
    const buf = Buffer.from('not a media file');
    expect(sniffContentType(buf)).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });

  it('detects MP3 from ID3 header', () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    expect(sniffContentType(buf)).toBe('audio/mpeg');
  });
});

describe('validateFileContent', () => {
  it('accepts valid JPEG content with matching mimetype', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(() => validateFileContent(buf, 'image/jpeg', ['image/jpeg', 'image/png'])).not.toThrow();
  });

  it('rejects content that does not match any allowed type', () => {
    const buf = Buffer.from('not a media file');
    expect(() => validateFileContent(buf, 'image/jpeg', ['image/jpeg', 'image/png'])).toThrow();
  });

  it('rejects when content type is not in allowed list', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG
    expect(() => validateFileContent(buf, 'audio/mpeg', ['audio/mpeg'])).toThrow();
  });
});
