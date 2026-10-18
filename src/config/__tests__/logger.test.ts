import pino from 'pino';
import { SENSITIVE_LOG_PATHS, createHttpLogShipper } from '../logger';
import http from 'http';

describe('Logger Configuration (Issue #380)', () => {
  it('redacts passwords, tokens, secrets, and auth headers from log records', () => {
    let capturedLog: any = null;

    const testStream = {
      write: (chunk: string) => {
        try {
          capturedLog = JSON.parse(chunk);
        } catch {
          // ignore
        }
      },
    };

    const testLogger = pino(
      {
        level: 'info',
        redact: {
          paths: SENSITIVE_LOG_PATHS,
          censor: '[REDACTED]',
        },
      },
      testStream,
    );

    testLogger.info(
      {
        password: 'my-super-secret-password',
        token: 'eyJh...token',
        apiKey: 'sk-live-12345',
        secret: 'very-secret',
        authorization: 'Bearer secret-jwt',
        user: {
          password: 'nested-password',
          refreshToken: 'refresh-123',
        },
        safeField: 'visible-value',
      },
      'User login test',
    );

    expect(capturedLog).toBeDefined();
    expect(capturedLog.password).toBe('[REDACTED]');
    expect(capturedLog.token).toBe('[REDACTED]');
    expect(capturedLog.apiKey).toBe('[REDACTED]');
    expect(capturedLog.secret).toBe('[REDACTED]');
    expect(capturedLog.authorization).toBe('[REDACTED]');
    expect(capturedLog.user.password).toBe('[REDACTED]');
    expect(capturedLog.user.refreshToken).toBe('[REDACTED]');
    expect(capturedLog.safeField).toBe('visible-value');
  });

  it('createHttpLogShipper buffers and ships logs to HTTP endpoint without throwing', (done) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        expect(parsed.streams).toBeDefined();
        expect(parsed.streams[0].values.length).toBeGreaterThan(0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        server.close(done);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      const shipper = createHttpLogShipper(`http://127.0.0.1:${port}/loki/api/v1/push`);

      // Write a log line to shipper
      shipper.write('{"level":30,"msg":"test log shipping line"}\n');

      // Fill buffer to trigger immediate flush
      for (let i = 0; i < 55; i++) {
        shipper.write(`{"level":30,"msg":"line ${i}"}\n`);
      }
    });
  });
});
