import 'reflect-metadata';

const mockListForUser = jest.fn();
const mockMarkAsRead = jest.fn();
const mockMarkAllAsRead = jest.fn();
const mockRegisterDeviceToken = jest.fn();
const mockRemoveDeviceToken = jest.fn();

jest.mock('../services/NotificationService', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    listForUser: mockListForUser,
    markAsRead: mockMarkAsRead,
    markAllAsRead: mockMarkAllAsRead,
    registerDeviceToken: mockRegisterDeviceToken,
    removeDeviceToken: mockRemoveDeviceToken,
  })),
}));

import { NotificationController } from '../controllers/NotificationController';
import { AppError } from '../errors/AppError';
import { Request, Response } from 'express';

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    body: {},
    params: {},
    query: {},
    user: { id: 'user-1' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  return { res: { json, status } as unknown as Response, json, status };
}

beforeEach(() => {
  mockListForUser.mockReset();
  mockMarkAsRead.mockReset();
  mockMarkAllAsRead.mockReset();
});

describe('NotificationController.list', () => {
  it('returns the caller notifications with pagination and unread count', async () => {
    mockListForUser.mockResolvedValue({
      data: [{ id: 'n1' }],
      unreadCount: 2,
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const req = mockReq({ query: { page: '1', limit: '20' } });
    const { res, json } = mockRes();

    await NotificationController.list(req, res);

    expect(mockListForUser).toHaveBeenCalledWith('user-1', 1, 20);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, unreadCount: 2 }));
  });
});

describe('NotificationController.markAsRead', () => {
  it('marks a notification as read', async () => {
    mockMarkAsRead.mockResolvedValue({ id: 'n1', isRead: true });

    const req = mockReq({ params: { id: 'n1' } });
    const { res, json } = mockRes();

    await NotificationController.markAsRead(req, res);

    expect(mockMarkAsRead).toHaveBeenCalledWith('n1', 'user-1');
    expect(json).toHaveBeenCalledWith({ success: true, data: { id: 'n1', isRead: true } });
  });

  it('propagates 404 errors from the service', async () => {
    mockMarkAsRead.mockRejectedValue(AppError.notFound('Notification not found'));

    const req = mockReq({ params: { id: 'ghost' } });
    const { res, status } = mockRes();

    await NotificationController.markAsRead(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });
});

describe('NotificationController.markAllAsRead', () => {
  it('marks everything as read and returns the count', async () => {
    mockMarkAllAsRead.mockResolvedValue({ updated: 3 });

    const req = mockReq();
    const { res, json } = mockRes();

    await NotificationController.markAllAsRead(req, res);

    expect(mockMarkAllAsRead).toHaveBeenCalledWith('user-1');
    expect(json).toHaveBeenCalledWith({ success: true, updated: 3 });
  });
});

describe('NotificationController.registerDeviceToken', () => {
  it('registers a device token for the authenticated user', async () => {
    mockRegisterDeviceToken.mockResolvedValue({
      id: 'dt-1',
      userId: 'user-1',
      token: 'fcm-token-xyz',
      platform: 'ios',
    });

    const req = mockReq({ body: { token: 'fcm-token-xyz', platform: 'ios' } });
    const { res, json } = mockRes();

    await NotificationController.registerDeviceToken(req, res);

    expect(mockRegisterDeviceToken).toHaveBeenCalledWith('user-1', 'fcm-token-xyz', 'ios');
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ token: 'fcm-token-xyz', platform: 'ios' }),
    });
  });
});

describe('NotificationController.removeDeviceToken', () => {
  it('removes a device token for the authenticated user', async () => {
    mockRemoveDeviceToken.mockResolvedValue(true);

    const req = mockReq({ body: { token: 'fcm-token-xyz' } });
    const { res, json } = mockRes();

    await NotificationController.removeDeviceToken(req, res);

    expect(mockRemoveDeviceToken).toHaveBeenCalledWith('user-1', 'fcm-token-xyz');
    expect(json).toHaveBeenCalledWith({ success: true, removed: true });
  });
});
