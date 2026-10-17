/**
 * Content-type sniffing via magic bytes (#350).
 * Validates actual file content, not just the filename extension or
 * client-declared mimetype.
 */

// Magic byte signatures for allowed image formats
const IMAGE_SIGNATURES: { bytes: number[]; mimetype: string }[] = [
  { bytes: [0xff, 0xd8, 0xff], mimetype: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimetype: 'image/png' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mimetype: 'image/webp' }, // RIFF...WEBP
];

// Magic byte signatures for allowed audio formats
const AUDIO_SIGNATURES: { bytes: number[]; mimetype: string }[] = [
  { bytes: [0x49, 0x44, 0x33], mimetype: 'audio/mpeg' }, // ID3 (MP3)
  { bytes: [0xff, 0xfb], mimetype: 'audio/mpeg' }, // MP3 frame sync
  { bytes: [0xff, 0xf3], mimetype: 'audio/mpeg' }, // MP3 frame sync
  { bytes: [0x4f, 0x67, 0x67, 0x53], mimetype: 'audio/ogg' }, // OggS
  { bytes: [0x66, 0x74, 0x79, 0x70], mimetype: 'audio/mp4' }, // ftyp (M4A/MP4)
  { bytes: [0x52, 0x49, 0x46, 0x46], mimetype: 'audio/wav' }, // RIFF...WAVE
  { bytes: [0x46, 0x4f, 0x52, 0x4d], mimetype: 'audio/aiff' }, // FORM
];

function matchesSignature(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, i) => buffer[i] === byte);
}

/**
 * Sniff the actual content type from magic bytes in the buffer.
 * Returns the detected mimetype, or null if unrecognized.
 */
export function sniffContentType(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;

  // Check image signatures first
  for (const sig of IMAGE_SIGNATURES) {
    if (matchesSignature(buffer, sig.bytes)) {
      // For WebP, also check for WEBP marker at offset 8
      if (sig.mimetype === 'image/webp') {
        if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
          return 'image/webp';
        }
        continue;
      }
      return sig.mimetype;
    }
  }

  // Check audio signatures
  for (const sig of AUDIO_SIGNATURES) {
    if (matchesSignature(buffer, sig.bytes)) {
      // For WAV, also check for WAVE marker at offset 8
      if (sig.mimetype === 'audio/wav') {
        if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE') {
          return 'audio/wav';
        }
        continue;
      }
      // For audio/mp4, check for M4A or isom at offset 8
      if (sig.mimetype === 'audio/mp4') {
        const brand = buffer.toString('ascii', 8, 12);
        if (['M4A ', 'isom', 'mp42'].includes(brand)) {
          return 'audio/mp4';
        }
        continue;
      }
      return sig.mimetype;
    }
  }

  return null;
}

/**
 * Validates that a buffer's actual content matches the expected type (#350).
 * Throws with a clear error if content doesn't match.
 */
export function validateFileContent(
  buffer: Buffer,
  expectedMimetype: string,
  allowedTypes: string[],
): void {
  const detected = sniffContentType(buffer);

  if (!detected) {
    throw new Error('File content could not be identified as a valid media file');
  }

  if (!allowedTypes.includes(detected)) {
    throw new Error(
      `File content type (${detected}) is not allowed. Expected one of: ${allowedTypes.join(', ')}`,
    );
  }

  // If we detected a specific type but the client claimed a different one,
  // that's suspicious but not necessarily wrong (e.g. audio/mpeg vs audio/mp3).
  // Only reject if the detected type is not in the allowed list at all.
  if (detected !== expectedMimetype && !allowedTypes.includes(detected)) {
    throw new Error(
      `File content (${detected}) does not match declared type (${expectedMimetype})`,
    );
  }
}
