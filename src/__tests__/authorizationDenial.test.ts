/**
 * authorizationDenial.test.ts (#353)
 *
 * Deny-by-default authorization tests for every artist-only and admin-only
 * route. Confirms that listener and unauthenticated requests are rejected,
 * not just that an artist request succeeds.
 */

import 'reflect-metadata';

// ── Module-level mocks ──────────────────────────────────────────────────────

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

jest.mock('../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  },
}));

// ── Import after mocks ─────────────────────────────────────────────────────

const {
  requireArtist,
  requireAdmin,
} = require('../middlewares/rbacMiddleware');

function mockReq(overrides: Partial<{ user: { role: string } }> = {}) {
  return {
    user: overrides.user,
  };
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Artist-only routes — deny by default', () => {
  describe('requireArtist middleware', () => {
    it('rejects unauthenticated requests (no user object)', () => {
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();
      requireArtist(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects listener-role requests', () => {
      const req = mockReq({ user: { role: 'LISTENER' } });
      const res = mockRes();
      const next = jest.fn();
      requireArtist(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects unverified artist requests', () => {
      const req = mockReq({ user: { role: 'ARTIST', verified: false } });
      const res = mockRes();
      const next = jest.fn();
      requireArtist(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows artist-role requests', () => {
      const req = mockReq({ user: { role: 'ARTIST', verified: true } });
      const res = mockRes();
      const next = jest.fn();
      requireArtist(req as any, res as any, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('requireArtistAndVerified middleware', () => {
    it('rejects unauthenticated requests', async () => {
      const { requireArtistAndVerified } = require('../middlewares/authMiddleware');
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();
      await requireArtistAndVerified(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects listener-role requests', async () => {
      const { requireArtistAndVerified } = require('../middlewares/authMiddleware');
      const req = mockReq({ user: { role: 'LISTENER' } });
      const res = mockRes();
      const next = jest.fn();
      await requireArtistAndVerified(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});

describe('Admin-only routes — deny by default', () => {
  describe('requireAdmin middleware', () => {
    it('rejects unauthenticated requests (no user object)', () => {
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();
      requireAdmin(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects listener-role requests', () => {
      const req = mockReq({ user: { role: 'LISTENER' } });
      const res = mockRes();
      const next = jest.fn();
      requireAdmin(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects artist-role requests', () => {
      const req = mockReq({ user: { role: 'ARTIST' } });
      const res = mockRes();
      const next = jest.fn();
      requireAdmin(req as any, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('allows admin-role requests', () => {
      const req = mockReq({ user: { role: 'ADMIN' } });
      const res = mockRes();
      const next = jest.fn();
      requireAdmin(req as any, res as any, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows super-admin-role requests', () => {
      const req = mockReq({ user: { role: 'SUPER_ADMIN' } });
      const res = mockRes();
      const next = jest.fn();
      requireAdmin(req as any, res as any, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
