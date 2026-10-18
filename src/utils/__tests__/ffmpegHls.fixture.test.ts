import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { transcodeToHLS } from '../ffmpeg';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

// Needs the ffmpeg/ffprobe binaries (installed in the production image); skipped elsewhere.
(hasFfmpeg ? describe : describe.skip)('transcodeToHLS with a real ffmpeg', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-fixture-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function generateTone(file: string) {
    const result = spawnSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=12',
      '-ar',
      '48000',
      '-ac',
      '2',
      file,
    ]);
    expect(result.status).toBe(0);
  }

  it('turns a WAV upload into a playable AAC playlist', async () => {
    const input = path.join(tmp, 'tone.wav');
    const outDir = path.join(tmp, 'hls');
    generateTone(input);

    await transcodeToHLS(input, outDir);

    const playlist = fs.readFileSync(path.join(outDir, 'master.m3u8'), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(fs.readdirSync(outDir).filter((f) => f.endsWith('.m4s')).length).toBeGreaterThan(0);

    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,sample_rate',
      '-of',
      'csv=p=0',
      path.join(outDir, 'master.m3u8'),
    ]);
    expect(probe.stdout.toString().trim()).toBe('aac,44100');
  });
});
