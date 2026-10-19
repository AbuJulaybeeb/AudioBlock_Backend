import ffmpeg from 'fluent-ffmpeg';
import { transcodeToHLS, TranscodeError } from '../ffmpeg';
import path from 'path';
jest.mock('fluent-ffmpeg');
jest.mock('fs', () => ({ mkdirSync: jest.fn() }));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

function command(fail = false) {
  const callbacks: Record<string, Function> = {};
  const cmd: { outputOptions: jest.Mock; output: jest.Mock; on: jest.Mock; run: jest.Mock } = {
    outputOptions: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    on: jest.fn((name, cb) => {
      callbacks[name] = cb;
      return cmd;
    }),
    run: jest.fn(() =>
      fail ? callbacks.error(new Error('encoder failed'), '', 'x'.repeat(5000)) : callbacks.end(),
    ),
  };
  jest.mocked(ffmpeg).mockReturnValue(cmd as any);
  return cmd;
}
it('preserves worker encoding options and playlist location', async () => {
  const cmd = command();
  await transcodeToHLS('song.mp3', 'hls', 'song-id');
  expect(cmd.outputOptions).toHaveBeenCalledWith([
    '-codec: copy',
    '-start_number 0',
    '-hls_time 10',
    '-hls_list_size 0',
    '-f hls',
  ]);
  expect(cmd.output).toHaveBeenCalledWith(path.join('hls', 'master.m3u8'));
});
it('rejects a typed error retaining bounded stderr', async () => {
  command(true);
  await expect(transcodeToHLS('song.mp3', 'hls')).rejects.toMatchObject({
    name: 'TranscodeError',
    message: 'encoder failed',
    stderrTail: 'x'.repeat(4096),
  });
  expect(new TranscodeError('failed')).toBeInstanceOf(Error);
const outputOptions = jest.fn();
const output = jest.fn();
const handlers: Record<string, (...args: any[]) => void> = {};

jest.mock('fluent-ffmpeg', () => {
  const instance: any = {
    outputOptions: (opts: string[]) => {
      outputOptions(opts);
      return instance;
    },
    output: (target: string) => {
      output(target);
      return instance;
    },
    on: (event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
      return instance;
    },
    run: () => handlers['end']?.(),
  };
  return { __esModule: true, default: jest.fn(() => instance) };
});
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { transcodeToHLS } from '../ffmpeg';

describe('transcodeToHLS', () => {
  let outDir: string;

  beforeEach(() => {
    outputOptions.mockClear();
    output.mockClear();
    outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hls-')), 'out');
  });

  it('re-encodes to AAC fMP4 HLS instead of copying the source codec', async () => {
    await transcodeToHLS('in.wav', outDir);

    const opts: string[] = outputOptions.mock.calls[0][0];
    expect(opts).toEqual(
      expect.arrayContaining([
        '-vn',
        '-c:a aac',
        '-b:a 256k',
        '-ar 44100',
        '-hls_segment_type fmp4',
      ]),
    );
    expect(opts.some((o) => o.includes('copy'))).toBe(false);
    expect(output).toHaveBeenCalledWith(path.join(outDir, 'master.m3u8'));
  });
});
