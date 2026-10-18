import fs from 'fs';

jest.mock('axios');
jest.mock('form-data');
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** ScanService reads SCAN_PROVIDER at import time, so load fresh modules per test. */
function load(provider?: string) {
  jest.resetModules();
  if (provider === undefined) delete process.env.SCAN_PROVIDER;
  else process.env.SCAN_PROVIDER = provider;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const post = require('axios').post as jest.Mock;
  const formAppend = jest.fn();
  (require('form-data') as jest.Mock).mockImplementation(() => ({
    append: formAppend,
    getHeaders: () => ({}),
  }));
  const ScanService = require('../ScanService')
    .ScanService as typeof import('../ScanService').ScanService;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { ScanService, post, formAppend };
}

describe('ScanService.scanFile', () => {
  const originalProvider = process.env.SCAN_PROVIDER;
  const stream = { fake: 'stream' };

  beforeEach(() => {
    jest.spyOn(fs, 'createReadStream').mockReturnValue(stream as any);
    jest.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalProvider === undefined) delete process.env.SCAN_PROVIDER;
    else process.env.SCAN_PROVIDER = originalProvider;
  });

  it('returns clean for a file the scanner reports as OK', async () => {
    const { ScanService, post } = load();
    post.mockResolvedValue({ data: { status: 'OK' } });

    await expect(ScanService.scanFile('/tmp/a.mp3')).resolves.toEqual({ clean: true });
  });

  it('returns the threat name for an infected file', async () => {
    const { ScanService, post } = load();
    post.mockResolvedValue({ data: { status: 'FOUND', virus: 'Eicar-Test-Signature' } });

    await expect(ScanService.scanFile('/tmp/a.mp3')).resolves.toEqual({
      clean: false,
      threat: 'Eicar-Test-Signature',
    });
  });

  it('treats a scanner ERROR status as not clean with an unknown threat', async () => {
    const { ScanService, post } = load();
    post.mockResolvedValue({ data: { status: 'ERROR' } });

    await expect(ScanService.scanFile('/tmp/a.mp3')).resolves.toEqual({
      clean: false,
      threat: 'unknown',
    });
  });

  it('fails closed when the scanner is unavailable', async () => {
    const { ScanService, post } = load();
    post.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(ScanService.scanFile('/tmp/a.mp3')).rejects.toThrow(
      /Malware scanning service is unavailable. Upload rejected/,
    );
  });

  it('fails closed when the scan times out', async () => {
    const { ScanService, post } = load();
    post.mockRejectedValue(new Error('timeout of 30000ms exceeded'));

    await expect(ScanService.scanFile('/tmp/a.mp3')).rejects.toThrow(/timeout of 30000ms exceeded/);
  });

  it('streams the file to the scanner instead of reading it into memory', async () => {
    const { ScanService, post, formAppend } = load();
    post.mockResolvedValue({ data: { status: 'OK' } });

    await ScanService.scanFile('/tmp/a.mp3');

    expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/a.mp3');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(formAppend).toHaveBeenCalledWith('file', stream, { filename: 'a.mp3' });
  });

  it('skips scanning without calling the scanner when SCAN_PROVIDER=skip', async () => {
    const { ScanService, post } = load('skip');

    await expect(ScanService.scanFile('/tmp/a.mp3')).resolves.toEqual({ clean: true });
    expect(post).not.toHaveBeenCalled();
  });
});
