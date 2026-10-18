import { s3 } from '../config/s3';

/**
 * Returns the object key for a URL that points into the configured bucket,
 * or null for any other URL (e.g. an IPFS gateway link).
 */
export function s3KeyFromUrl(url?: string | null): string | null {
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!url || !bucket) return null;
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.startsWith(`${bucket}.s3`)) return null;
    return decodeURIComponent(pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

/** Deletes the given keys from the configured bucket. */
export async function deleteS3Objects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await s3
    .deleteObjects({
      Bucket: process.env.AWS_BUCKET_NAME!,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    })
    .promise();
}

/** Deletes every object under a key prefix in the configured bucket. */
export async function deleteS3Prefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await s3
      .listObjectsV2({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
      .promise();
    await deleteS3Objects((page.Contents ?? []).map((o) => o.Key!));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}
