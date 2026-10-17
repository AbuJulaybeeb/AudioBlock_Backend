import AWS from 'aws-sdk';
import AppDataSource from '../config/db';
import { Song } from '../entities/Song';
import redis from '../config/redis';

const s3 = new AWS.S3({ region: process.env.AWS_REGION });

const CACHE_TTL = Number(process.env.MANIFEST_CACHE_TTL || 300); // seconds

// #352 — Presigned URL expiry rationale:
// 5 minutes (300s) balances usability against exposure window.
// - HLS segments are short (~2-10s each); a 5-min URL covers many segments
//   and re-fetching on expiry is cheap (CDN-cached).
// - Longer expiry (e.g. 1hr) increases the window if a URL leaks.
// - Shorter expiry (e.g. 60s) causes frequent re-fetches during continuous
//   playback and increases latency when seeking.
// Override via SIGNED_URL_EXPIRES for deployments with different CDN/latency profiles.
const SIGNED_EXPIRES = Number(process.env.SIGNED_URL_EXPIRES || 300);

function getSignedUrl(key: string) {
  return s3.getSignedUrl('getObject', {
    Bucket: process.env.AWS_BUCKET_NAME!,
    Key: key,
    Expires: SIGNED_EXPIRES,
  });
}

export async function precomputeSignedManifest(songId: string) {
  const songRepo = AppDataSource.getRepository(Song);
  const song = await songRepo.findOneBy({ id: songId });

  if (!song || !song.hlsMasterUrl) throw new Error('No HLS manifest for song');

  // derive the S3 key for master.m3u8
  const masterKey = s3KeyFromUrl(song.hlsMasterUrl); // helper below

  const masterObj = await s3
    .getObject({
      Bucket: process.env.AWS_BUCKET_NAME!,
      Key: masterKey,
    })
    .promise();
  const manifest = masterObj.Body!.toString('utf-8');

  // rewrite manifest: replace relative ts lines or absolute paths
  const signedManifest = await rewriteManifest(manifest, songId);

  await redis.setex(`manifest:${songId}`, CACHE_TTL, signedManifest);
  return signedManifest;
}

function s3KeyFromUrl(url: string) {
  // e.g. https://bucket.s3.eu-north-1.amazonaws.com/songs/<id>/hls/master.m3u8
  const parts = url.split('.com/');
  if (parts.length < 2) throw new Error('Invalid S3 URL');
  return parts[1];
}

async function rewriteManifest(manifest: string, songId: string) {
  // This handles simple manifests where segment lines are relative filenames (e.g., segment000.ts)
  // It also handles lines already absolute URLs by extracting filename.
  // For variant playlists (multi-bit-rate), more logic required to rewrite nested playlists — see notes later.

  const lines = manifest.split('\n');
  const rewrittenLines = await Promise.all(
    lines.map(async (line) => {
      line = line.trim();
      if (!line || line.startsWith('#')) return line; // comment/metadata
      // candidate segment or nested playlist path
      const filename = line.split('/').pop() || line; // get last part
      const key = `songs/${songId}/hls/${filename}`;
      const signed = getSignedUrl(key);
      return signed;
    }),
  );
  return rewrittenLines.join('\n');
}
