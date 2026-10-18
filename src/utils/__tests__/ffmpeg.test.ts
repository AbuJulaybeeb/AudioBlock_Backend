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
});
