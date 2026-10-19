import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

import AppDataSource from '../config/db';
import { NotificationService } from '../services/NotificationService';
import { Notification } from '../entities/Notification';

const mockNotificationRepo = {
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  findAndCount: jest.fn(),
  count: jest.fn(),
  findOneBy: jest.fn(),
  update: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockNotificationRepo);
});

function makeSvc(): NotificationService {
  return new NotificationService();
}

const notification = (overrides: Partial<Notification> = {}): Notification =>
  ({
    id: 'n1',
    userId: 'user-1',
    type: 'song_status',
    title: 'Song is live',
    message: 'Your song is live',
    data: null,
    isRead: false,
    ...overrides,
  }) as Notification;

describe('NotificationService.create', () => {
  it('creates an unread notification', async () => {
    mockNotificationRepo.create.mockImplementation((input: unknown) => input);
    mockNotificationRepo.save.mockImplementation(async (n: Notification) => n);

    const svc = makeSvc();
    const result = await svc.create({
      userId: 'user-1',
      type: 'royalty_payout',
      title: 'Payout',
      message: 'You got paid',
      data: { amount: '100' },
    });

    expect(mockNotificationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'royalty_payout',
        isRead: false,
        data: { amount: '100' },
      }),
    );
    expect(result.isRead).toBe(false);
  });
});

describe('NotificationService.listForUser', () => {
  it('returns paginated notifications with an unread count', async () => {
    mockNotificationRepo.findAndCount.mockResolvedValue([[notification()], 1]);
    mockNotificationRepo.count.mockResolvedValue(1);

    const svc = makeSvc();
    const result = await svc.listForUser('user-1', 1, 20);

    expect(mockNotificationRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      }),
    );
    expect(mockNotificationRepo.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
    });
    expect(result.unreadCount).toBe(1);
    expect(result.pagination.total).toBe(1);
  });
});

describe('NotificationService.markAsRead', () => {
  it('marks an unread notification as read', async () => {
    const n = notification({ isRead: false });
    mockNotificationRepo.findOneBy.mockResolvedValue(n);
    mockNotificationRepo.save.mockImplementation(async (saved: Notification) => saved);

    const svc = makeSvc();
    const result = await svc.markAsRead('n1', 'user-1');

    expect(n.isRead).toBe(true);
    expect(mockNotificationRepo.save).toHaveBeenCalledWith(n);
    expect(result.isRead).toBe(true);
  });

  it('is a no-op for already-read notifications', async () => {
    const n = notification({ isRead: true });
    mockNotificationRepo.findOneBy.mockResolvedValue(n);

    const svc = makeSvc();
    await svc.markAsRead('n1', 'user-1');

    expect(mockNotificationRepo.save).not.toHaveBeenCalled();
  });

  it('throws 404 for a missing notification', async () => {
    mockNotificationRepo.findOneBy.mockResolvedValue(null);

    const svc = makeSvc();
    await expect(svc.markAsRead('ghost', 'user-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('denies marking another user notification as read', async () => {
    mockNotificationRepo.findOneBy.mockResolvedValue(notification({ userId: 'other-user' }));

    const svc = makeSvc();
    await expect(svc.markAsRead('n1', 'user-1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('NotificationService.markAllAsRead', () => {
  it('updates all unread notifications and returns the affected count', async () => {
    mockNotificationRepo.update.mockResolvedValue({ affected: 4 });

    const svc = makeSvc();
    const result = await svc.markAllAsRead('user-1');

    expect(mockNotificationRepo.update).toHaveBeenCalledWith(
      { userId: 'user-1', isRead: false },
      { isRead: true },
    );
    expect(result).toEqual({ updated: 4 });
  });
});
