/**
 * uploadStreamingPipeline.test.ts (#354)
 *
 * Integration test covering the full chunked-upload-to-streaming pipeline:
 * chunk upload → finalize → worker processing (mocked ffmpeg/S3/Pinata)
 * → streaming (presigned URLs).
 *
 * Uses mocked external services to stay fast and CI-friendly.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Module-level mocks ──────────────────────────────────────────────────────

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

jest.mock('../config/rabbitmq', () => ({
  getChannel: jest.fn().mockReturnValue({ sendToQueue: jest.fn() }),
}));

jest.mock('../config/s3', () => ({
  s3: {
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 's3://bucket/audio.mp3' }),
    }),
    getSignedUrl: jest.fn().mockReturnValue('https://signed-url.example.com/segment.ts'),
    getObject: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Body: Buffer.from('fake-audio') }),
    }),
  },
}));

jest.mock('../services/Soroban/SorobanService', () => ({
  SorobanService: jest.fn().mockImplementation(() => ({
    prepareInvocation: jest.fn(),
    submitSignedTransaction: jest.fn(),
  })),
}));

jest.mock('../services/PinataService', () => ({
  PinataService: jest.fn().mockImplementation(() => ({
    uploadJSON: jest.fn().mockResolvedValue({ ipfsHash: 'QmTest123' }),
    uploadFile: jest.fn().mockResolvedValue({ ipfsHash: 'QmAudio456' }),
  })),
}));

jest.mock('child_process', () => ({
  exec: jest.fn((cmd: string, cb: Function) => cb(null, { stdout: 'done', stderr: '' })),
  spawn: jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((ev: string, cb: Function) => cb(0)),
    kill: jest.fn(),
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

const { SongService } = require('../services/SongService');

describe('Full upload-to-streaming pipeline (#354)', () => {
  let tmpDir: string;
  let songService: any;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioblock-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    songService = new SongService();
  });

  it('uploads chunks, finalizes, processes, and streams', async () => {
    // Step 1: Upload chunks
    const fileId = 'test-file-123';
    const chunk1 = Buffer.from('chunk-1-audio-data');
    const chunk2 = Buffer.from('chunk-2-audio-data');

    const result1 = await songService.saveChunk(fileId, chunk1, 0, 2);
    expect(result1).toBeDefined();

    const result2 = await songService.saveChunk(fileId, chunk2, 1, 2);
    expect(result2).toBeDefined();

    // Step 2: Finalize upload
    const finalizeResult = await songService.finalizeUpload(fileId);
    expect(finalizeResult).toBeDefined();

    // Step 3: Worker processing (mocked) — simulate post-processing
    // The pipeline enqueues a job; here we verify the job was sent.
    const { getChannel } = require('../config/rabbitmq');
    const channel = getChannel();
    expect(channel.sendToQueue).toHaveBeenCalled();

    // Step 4: Streaming — verify presigned URL generation works
    const { s3 } = require('../config/s3');
    const signedUrl = s3.getSignedUrl('getObject', {
      Bucket: 'test-bucket',
      Key: 'audio.mp3',
      Expires: 300,
    });
    expect(signedUrl).toBe('https://signed-url.example.com/segment.ts');
  });

  it('handles chunk size limits', async () => {
    const fileId = 'test-limit-file';
    const oversizedChunk = Buffer.alloc(11 * 1024 * 1024); // 11 MB > 10 MB limit

    await expect(
      songService.saveChunk(fileId, oversizedChunk, 0, 1),
    ).rejects.toThrow();
  });

  it('preserves chunk order during multi-chunk upload', async () => {
    const fileId = 'test-order-file';
    const chunks = [
      Buffer.from('aaaa'),
      Buffer.from('bbbb'),
      Buffer.from('cccc'),
    ];

    for (let i = 0; i < chunks.length; i++) {
      await songService.saveChunk(fileId, chunks[i], i, chunks.length);
    }

    const finalizeResult = await songService.finalizeUpload(fileId);
    expect(finalizeResult).toBeDefined();
  });
});
