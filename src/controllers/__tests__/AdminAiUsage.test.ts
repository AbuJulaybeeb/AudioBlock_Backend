import express from 'express';
import request from 'supertest';
import { createMockRequest, createMockResponse, generateAuthToken } from '../../../tests/helpers';
import { UserRole } from '../../entities/User';
import { Permission, roleHasPermission } from '../../types/Permissions';

// handleError -> logRequestError imports the live Redis client; mock it so the
// suite never opens a socket.
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { incr: jest.fn(), expire: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const mockGetUsageSummary = jest.fn();
jest.mock('../../services/ai/AiUsageService', () => ({
  AiUsageService: jest.fn().mockImplementation(() => ({
    getUsageSummary: (...args: unknown[]) => mockGetUsageSummary(...args),
  })),
}));

// AdminController wires up several services at module load; none of them are
// exercised here, so stub them out to keep the DB data source unloaded.
jest.mock('../../services/UserService', () => ({ UserService: jest.fn() }));
jest.mock('../../services/ArtistProfileService', () => ({ ArtistProfileService: jest.fn() }));
jest.mock('../../services/TransactionLogService', () => ({ TransactionLogService: jest.fn() }));
jest.mock('../../services/ReportService', () => ({ ReportService: jest.fn() }));
jest.mock('../../services/CommentReportService', () => ({ CommentReportService: jest.fn() }));
jest.mock('../../services/IndexerService', () => ({ IndexerService: jest.fn() }));
jest.mock('../../services/Song/SongModerationService', () => ({
  SongModerationService: jest.fn(),
}));

import { AdminController } from '../AdminController';
import { requirePermission } from '../../middlewares/authMiddleware';

const SUMMARY = {
  range: { from: null, to: null },
  totals: { total: 2, completed: 2, failed: 0, pending: 0 },
  byFeature: [{ feature: 'coverArt', total: 2, completed: 2, failed: 0, pending: 0 }],
  byArtist: [
    {
      artistId: 'artist-a',
      artistName: 'Artist A',
      total: 2,
      completed: 2,
      failed: 0,
      pending: 0,
      byFeature: { coverArt: 2 },
    },
  ],
  artistCount: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUsageSummary.mockResolvedValue(SUMMARY);
});

describe('AdminController.getAiUsage (#289)', () => {
  it('returns usage aggregated by feature and artist', async () => {
    const req = createMockRequest({ query: {} });
    const res = createMockResponse();

    await AdminController.getAiUsage(req, res as any);

    expect(mockGetUsageSummary).toHaveBeenCalledWith({
      from: undefined,
      to: undefined,
      artistLimit: 50,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: SUMMARY });
  });

  it('passes the date range and clamps the artist limit', async () => {
    const req = createMockRequest({
      query: { from: '2026-01-01', to: '2026-02-01', limit: '10000' },
    });
    const res = createMockResponse();

    await AdminController.getAiUsage(req, res as any);

    expect(mockGetUsageSummary).toHaveBeenCalledWith({
      from: new Date('2026-01-01'),
      to: new Date('2026-02-01'),
      artistLimit: 200,
    });
  });

  it.each([
    [{ from: 'not-a-date' }],
    [{ to: 'yesterday' }],
    [{ from: '2026-03-01', to: '2026-02-01' }],
  ])('rejects an invalid date range %p with 400', async (query) => {
    const req = createMockRequest({ query });
    const res = createMockResponse();

    await AdminController.getAiUsage(req, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetUsageSummary).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/ai/usage admin gating (#289)', () => {
  // Mirrors the route registration in src/routes/adminRoutes.ts.
  const app = express();
  app.get(
    '/api/admin/ai/usage',
    requirePermission(Permission.AI_USAGE_VIEW),
    AdminController.getAiUsage,
  );

  const tokenFor = (role: UserRole) => generateAuthToken(`user-${role}`, { role });

  it('grants the permission to admins and super admins only', () => {
    expect(roleHasPermission(UserRole.ADMIN, Permission.AI_USAGE_VIEW)).toBe(true);
    expect(roleHasPermission(UserRole.SUPER_ADMIN, Permission.AI_USAGE_VIEW)).toBe(true);
    expect(roleHasPermission(UserRole.MODERATOR, Permission.AI_USAGE_VIEW)).toBe(false);
    expect(roleHasPermission(UserRole.ARTIST, Permission.AI_USAGE_VIEW)).toBe(false);
    expect(roleHasPermission(UserRole.LISTENER, Permission.AI_USAGE_VIEW)).toBe(false);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(app).get('/api/admin/ai/usage');

    expect(res.status).toBe(401);
    expect(mockGetUsageSummary).not.toHaveBeenCalled();
  });

  it.each([UserRole.ARTIST, UserRole.MODERATOR, UserRole.LISTENER])(
    'rejects %s callers with 403',
    async (role) => {
      const res = await request(app)
        .get('/api/admin/ai/usage')
        .set('Authorization', `Bearer ${tokenFor(role)}`);

      expect(res.status).toBe(403);
      expect(mockGetUsageSummary).not.toHaveBeenCalled();
    },
  );

  it('serves admins', async () => {
    const res = await request(app)
      .get('/api/admin/ai/usage')
      .set('Authorization', `Bearer ${tokenFor(UserRole.ADMIN)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: SUMMARY });
  });
});
