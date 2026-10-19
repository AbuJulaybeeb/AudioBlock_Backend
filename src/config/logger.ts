/**
 * Structured logger configuration (Issue #33, #380)
 *
 * Uses pino for structured, levelled logging with request correlation.
 * Log level is controlled via the LOG_LEVEL env var (default: "info").
 *
 * Redaction (#380):
 *   All sensitive credentials (passwords, tokens, API keys, secrets, authorization
 *   headers) are strictly redacted before output to prevent leaking credentials
 *   to stdout or any log aggregator.
 *
 * Shipping to Log Aggregator (#380):
 *   - Docker/Compose/K8s: Promtail/Fluentbit sidecar scrapes container logs and
 *     ships them to Grafana Loki, queryable via Grafana Explore.
 *   - Direct SDK/HTTP: If LOG_AGGREGATOR_URL is configured, logger streams
 *     batched log entries directly to the aggregator endpoint.
 *
 * Usage:
 *   import logger from './config/logger';
 *   logger.info({ reqId, route: req.path, status: 200 }, 'Request complete');
 *   logger.error({ reqId, err }, 'Something failed');
 */
import pino from 'pino';
import http from 'http';
import https from 'https';
import { URL } from 'url';

/** Sensitive field paths to redact before output/shipping (Issue #380). */
export const SENSITIVE_LOG_PATHS = [
  'password',
  '*.password',
  '*.*.password',
  'newPassword',
  '*.newPassword',
  'oldPassword',
  '*.oldPassword',
  'confirmPassword',
  '*.confirmPassword',
  'token',
  '*.token',
  '*.*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'req.headers.authorization',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'jwtSecret',
  '*.jwtSecret',
  'clientSecret',
  '*.clientSecret',
  'privateKey',
  '*.privateKey',
  'twoFactorSecret',
  'totpSecret',
  'creditCard',
  'cardNumber',
  'cvv',
  'ssn',
];

/** Creates an HTTP log shipper destination for direct aggregator shipping (Issue #380). */
export function createHttpLogShipper(aggregatorUrl: string): pino.DestinationStream {
  const parsed = new URL(aggregatorUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  let buffer: string[] = [];
  let flushTimeout: NodeJS.Timeout | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    flushTimeout = null;

    const payload = JSON.stringify({
      streams: [
        {
          stream: {
            service: 'audioblock-backend',
            env: process.env.NODE_ENV || 'development',
          },
          values: batch.map((line) => [String(Date.now() * 1000000), line]),
        },
      ],
    });

    try {
      const req = client.request(parsed, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      });
      req.on('error', () => {
        // Fail-open: aggregator network issue must never crash application
      });
      req.write(payload);
      req.end();
    } catch {
      // Fail-open
    }
  };

  return {
    write(chunk: string) {
      buffer.push(chunk.trim());
      if (buffer.length >= 50) {
        if (flushTimeout) clearTimeout(flushTimeout);
        flush();
      } else if (!flushTimeout) {
        flushTimeout = setTimeout(flush, 2000);
      }
    },
  };
}

const baseOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: SENSITIVE_LOG_PATHS,
    censor: '[REDACTED]',
  },
  base: {
    service: 'audioblock-backend',
    env: process.env.NODE_ENV || 'development',
  },
};

function buildLogger(): pino.Logger {
  const aggregatorUrl = process.env.LOG_AGGREGATOR_URL;

  if (aggregatorUrl) {
    const streams: pino.StreamEntry[] = [
      { stream: process.stdout },
      { stream: createHttpLogShipper(aggregatorUrl) },
    ];
    return pino(baseOptions, pino.multistream(streams));
  }

  if (process.env.NODE_ENV !== 'production' && !process.env.CI) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}

const logger = buildLogger();

export default logger;
