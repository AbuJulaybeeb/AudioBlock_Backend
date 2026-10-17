import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION });

/**
 * Validates and sanitizes an S3 key component to prevent path traversal
 * and key collisions (#351). Rejects empty strings, path separators,
 * and characters that could cause key collisions or traversal.
 */
export function sanitizeS3KeyPart(value: string, fieldName: string): string {
  if (!value || typeof value !== 'string') {
    throw new Error(`Invalid S3 key part: ${fieldName} must be a non-empty string`);
  }
  // Reject path traversal and separator characters
  if (/[/\\]|\.\./.test(value)) {
    throw new Error(`Invalid S3 key part: ${fieldName} contains path separators or traversal`);
  }
  // Reject characters that could cause collisions or URL encoding issues
  if (/[^a-zA-Z0-9_-]/.test(value)) {
    throw new Error(`Invalid S3 key part: ${fieldName} contains invalid characters`);
  }
  // Cap length to prevent overly long keys
  if (value.length > 128) {
    throw new Error(`Invalid S3 key part: ${fieldName} exceeds maximum length`);
  }
  return value;
}

/**
 * Builds a sanitized S3 key from validated parts (#351).
 * Each part is validated before concatenation to prevent path traversal
 * and key collisions between users' files.
 */
export function buildS3Key(...parts: string[]): string {
  return parts.map((part, i) => sanitizeS3KeyPart(part, `part_${i}`)).join('/');
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType = 'application/octet-stream',
) {
  // Validate the key doesn't contain traversal patterns (#351)
  if (/(\.\.[/\\])|([/\\]\.\.)/.test(key)) {
    throw new Error('Invalid S3 key: path traversal detected');
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}
