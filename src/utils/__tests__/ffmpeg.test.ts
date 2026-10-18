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
