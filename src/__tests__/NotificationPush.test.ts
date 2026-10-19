import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

import AppDataSource from '../config/db';
import { NotificationService } from '../services/NotificationService';
import { Notification } from '../entities/Notification';
import { DeviceToken } from '../entities/DeviceToken';
import { MockPushNotificationProvider } from '../services/PushNotificationProvider';

describe('Push Notification Delivery Channel (Issue #429)', () => {
  let mockNotificationRepo: any;
  let mockDeviceTokenRepo: any;
  let mockPushProvider: MockPushNotificationProvider;
  let notificationService: NotificationService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockNotificationRepo = {
      create: jest.fn().mockImplementation((dto) => ({ id: 'notif-1', ...dto })),
      save: jest.fn().mockImplementation(async (n) => n),
      findAndCount: jest.fn(),
      count: jest.fn(),
      findOneBy: jest.fn(),
      update: jest.fn(),
    };

    mockDeviceTokenRepo = {
      create: jest.fn().mockImplementation((dto) => ({ id: 'token-id-1', ...dto })),
      save: jest.fn().mockImplementation(async (t) => t),
      findOneBy: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    };

    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
      if (entity === Notification) return mockNotificationRepo;
      if (entity === DeviceToken) return mockDeviceTokenRepo;
      return {};
    });

    mockPushProvider = new MockPushNotificationProvider();
    notificationService = new NotificationService(mockPushProvider);
  });

  describe('Device token registration and removal', () => {
    it('registers a new device token for a user', async () => {
      mockDeviceTokenRepo.findOneBy.mockResolvedValue(null);

      const token = await notificationService.registerDeviceToken('user-1', 'fcm-token-abc', 'ios');

      expect(mockDeviceTokenRepo.findOneBy).toHaveBeenCalledWith({
        userId: 'user-1',
        token: 'fcm-token-abc',
      });
      expect(mockDeviceTokenRepo.create).toHaveBeenCalledWith({
        userId: 'user-1',
        token: 'fcm-token-abc',
        platform: 'ios',
      });
      expect(token.platform).toBe('ios');
    });

    it('updates an existing device token if already registered', async () => {
      const existing = {
        id: 'token-id-1',
        userId: 'user-1',
        token: 'fcm-token-abc',
        platform: 'web',
      };
      mockDeviceTokenRepo.findOneBy.mockResolvedValue(existing);

      const updated = await notificationService.registerDeviceToken(
        'user-1',
        'fcm-token-abc',
        'android',
      );

      expect(existing.platform).toBe('android');
      expect(mockDeviceTokenRepo.save).toHaveBeenCalledWith(existing);
      expect(updated.platform).toBe('android');
    });

    it('removes a registered device token', async () => {
      mockDeviceTokenRepo.delete.mockResolvedValue({ affected: 1 });

      const removed = await notificationService.removeDeviceToken('user-1', 'fcm-token-abc');

      expect(mockDeviceTokenRepo.delete).toHaveBeenCalledWith({
        userId: 'user-1',
        token: 'fcm-token-abc',
      });
      expect(removed).toBe(true);
    });

    it('returns false when removing a non-existent token', async () => {
      mockDeviceTokenRepo.delete.mockResolvedValue({ affected: 0 });

      const removed = await notificationService.removeDeviceToken(
        'user-1',
        'fcm-token-non-existent',
      );
      expect(removed).toBe(false);
    });

    it('rejects registration with empty token or userId', async () => {
      await expect(notificationService.registerDeviceToken('', 'token-123')).rejects.toThrow();
      await expect(notificationService.registerDeviceToken('user-1', '')).rejects.toThrow();
    });
  });

  describe('Push delivery alongside in-app notification creation', () => {
    it('creates an in-app notification and dispatches push to user device tokens', async () => {
      mockDeviceTokenRepo.find.mockResolvedValue([
        { token: 'device-token-1', platform: 'ios' },
        { token: 'device-token-2', platform: 'web' },
      ]);

      const result = await notificationService.create({
        userId: 'user-1',
        type: 'song_status',
        title: 'Song Transcoded',
        message: 'Your song has completed processing.',
        data: { songId: 'song-123' },
      });

      // 1. In-app notification must always be created and saved in database
      expect(mockNotificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'song_status',
          title: 'Song Transcoded',
          message: 'Your song has completed processing.',
          isRead: false,
        }),
      );
      expect(mockNotificationRepo.save).toHaveBeenCalled();
      expect(result.title).toBe('Song Transcoded');

      // 2. Push notification dispatched via mocked push provider to registered devices
      expect(mockPushProvider.dispatched).toHaveLength(1);
      expect(mockPushProvider.dispatched[0].tokens).toEqual(['device-token-1', 'device-token-2']);
      expect(mockPushProvider.dispatched[0].payload).toEqual({
        title: 'Song Transcoded',
        body: 'Your song has completed processing.',
        data: { songId: 'song-123' },
      });
    });

    it('does not dispatch push when user has no registered device tokens, but still creates in-app notification', async () => {
      mockDeviceTokenRepo.find.mockResolvedValue([]);

      const result = await notificationService.create({
        userId: 'user-no-devices',
        type: 'system',
        title: 'System Alert',
        message: 'Maintenance scheduled.',
      });

      // In-app notification created
      expect(mockNotificationRepo.save).toHaveBeenCalled();
      expect(result.id).toBe('notif-1');

      // No push dispatched
      expect(mockPushProvider.dispatched).toHaveLength(0);
    });

    it('preserves in-app notification delivery even if the push provider fails or throws', async () => {
      mockDeviceTokenRepo.find.mockResolvedValue([
        { token: 'device-token-failing', platform: 'android' },
      ]);

      // Simulate push provider outage / failure
      mockPushProvider.shouldFail = true;

      const result = await notificationService.create({
        userId: 'user-1',
        type: 'marketplace_sale',
        title: 'NFT Sold',
        message: 'Your music NFT sold for 50 XLM.',
      });

      // In-app notification creation must NOT fail or throw
      expect(mockNotificationRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.title).toBe('NFT Sold');
    });
  });
});
