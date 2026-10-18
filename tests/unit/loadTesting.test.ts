import { runStreamingBenchmark } from '../../scripts/load-test-streaming';
import { runChunkedUploadBenchmark } from '../../scripts/load-test-chunked-upload';

describe('Load Testing Scripts Unit Tests (#370 & #371)', () => {
  it('should export runStreamingBenchmark function for Issue #370', () => {
    expect(typeof runStreamingBenchmark).toBe('function');
  });

  it('should export runChunkedUploadBenchmark function for Issue #371', () => {
    expect(typeof runChunkedUploadBenchmark).toBe('function');
  });

  it('should format valid multipart request in Artillery upload processor', (done) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setupUploadChunk } = require('../load/upload-processor');
    const req = { headers: {} as Record<string, string> };
    const context = { vars: {} as Record<string, unknown> };

    setupUploadChunk(req, context, {}, () => {
      expect(typeof context.vars.fileId).toBe('string');
      expect((context.vars.fileId as string).startsWith('artillery-')).toBe(true);
      expect(req.headers['content-type']).toContain('multipart/form-data');
      done();
    });
  });
});
