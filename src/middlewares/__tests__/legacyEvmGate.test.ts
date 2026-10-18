import express from 'express';
import request from 'supertest';
import { requireLegacyEvmAuth } from '../legacyEvmGate';

function buildApp() {
  const app = express();
  app.post('/login', requireLegacyEvmAuth, (_req, res) => {
    res.status(200).json({ success: true });
  });
  return app;
}

describe('requireLegacyEvmAuth', () => {
  const original = process.env.ENABLE_LEGACY_EVM_AUTH;

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_LEGACY_EVM_AUTH;
    else process.env.ENABLE_LEGACY_EVM_AUTH = original;
  });

  it('returns 410 when the flag is unset', async () => {
    delete process.env.ENABLE_LEGACY_EVM_AUTH;

    const res = await request(buildApp()).post('/login');

    expect(res.status).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Privy/);
  });

  it('returns 410 when the flag is false', async () => {
    process.env.ENABLE_LEGACY_EVM_AUTH = 'false';

    const res = await request(buildApp()).post('/login');

    expect(res.status).toBe(410);
  });

  it('passes through to the handler when the flag is true', async () => {
    process.env.ENABLE_LEGACY_EVM_AUTH = 'true';

    const res = await request(buildApp()).post('/login');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
