import { Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { Notification, NotificationType } from '../entities/Notification';
import { DeviceToken } from '../entities/DeviceToken';
import {
  IPushNotificationProvider,
  DefaultPushNotificationProvider,
} from './PushNotificationProvider';
import { AppError } from '../errors/AppError';
import logger from '../config/logger';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType | string;
  title: string;
  message: string;
  data?: Record<string, any> | null;
}

/**
 * Database-backed user notifications with multi-channel push delivery (Issues #79, #429).
 *
 * Notifications are created programmatically (e.g. by the royalty payout,
 * song processing, and marketplace flows) and delivered through both in-app
 * persistence and mobile/web push delivery channels.
 */
export class NotificationService {
  private notificationRepo: Repository<Notification>;
  private deviceTokenRepo: Repository<DeviceToken>;
  private pushProvider: IPushNotificationProvider;

  constructor(pushProvider?: IPushNotificationProvider) {
    this.notificationRepo = AppDataSource.getRepository(Notification);
    this.deviceTokenRepo = AppDataSource.getRepository(DeviceToken);
    this.pushProvider = pushProvider || new DefaultPushNotificationProvider();
  }

  /**
   * Set or override the push notification provider (e.g. in tests).
   */
  setPushProvider(provider: IPushNotificationProvider): void {
    this.pushProvider = provider;
  }

  /**
   * Get current push notification provider.
   */
  getPushProvider(): IPushNotificationProvider {
    return this.pushProvider;
  }

  /**
   * Register or update a device token for push notification delivery.
   */
  async registerDeviceToken(
    userId: string,
    token: string,
    platform: string = 'web',
  ): Promise<DeviceToken> {
    if (!userId || !userId.trim()) {
      throw AppError.validation('User ID is required', undefined, 'INVALID_USER_ID');
    }
    if (!token || !token.trim()) {
      throw AppError.validation('Device token is required', undefined, 'INVALID_DEVICE_TOKEN');
    }

    const trimmedToken = token.trim();
    const normalizedPlatform = ['ios', 'android', 'web'].includes(platform.toLowerCase())
      ? platform.toLowerCase()
      : 'web';

    const existing = await this.deviceTokenRepo.findOneBy({ userId, token: trimmedToken });
    if (existing) {
      existing.platform = normalizedPlatform;
      return this.deviceTokenRepo.save(existing);
    }

    const newRecord = this.deviceTokenRepo.create({
      userId,
      token: trimmedToken,
      platform: normalizedPlatform,
    });
    return this.deviceTokenRepo.save(newRecord);
  }

  /**
   * Remove a registered device token for a user.
   */
  async removeDeviceToken(userId: string, token: string): Promise<boolean> {
    if (!userId || !token) {
      throw AppError.validation(
        'User ID and device token are required',
        undefined,
        'INVALID_ARGUMENTS',
      );
    }

    const result = await this.deviceTokenRepo.delete({
      userId,
      token: token.trim(),
    });
    return (result.affected ?? 0) > 0;
  }

  /**
   * List all registered device tokens for a user.
   */
  async getDeviceTokensForUser(userId: string): Promise<DeviceToken[]> {
    return this.deviceTokenRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Create a notification for a user.
   *
   * Saves the in-app notification record and dispatches a push notification
   * alongside in-app delivery to all registered user devices.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const notification = this.notificationRepo.create({
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      data: input.data ?? null,
      isRead: false,
    });
    const savedNotification = await this.notificationRepo.save(notification);

    // Multi-channel delivery: Push delivery alongside in-app notification (Issue #429)
    try {
      const deviceTokens = await this.deviceTokenRepo.find({
        where: { userId: input.userId },
      });
      if (deviceTokens && deviceTokens.length > 0) {
        const tokenStrings = deviceTokens.map((dt) => dt.token).filter(Boolean);
        if (tokenStrings.length > 0) {
          await this.pushProvider.sendPush(tokenStrings, {
            title: input.title,
            body: input.message,
            data: input.data,
          });
        }
      }
    } catch (pushError) {
      // Push failure must never prevent in-app notification creation
      logger.warn(
        { err: pushError, userId: input.userId },
        'Failed to dispatch push notification delivery (in-app notification preserved)',
      );
    }

    return savedNotification;
  }

  /**
   * List a user's notifications, newest first, with an unread count.
   */
  async listForUser(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{
    data: Notification[];
    unreadCount: number;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const [items, total] = await this.notificationRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    const unreadCount = await this.notificationRepo.count({
      where: { userId, isRead: false },
    });

    return {
      data: items,
      unreadCount,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 0,
      },
    };
  }

  /**
   * Mark a single notification as read. Only the recipient may do so.
   */
  async markAsRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOneBy({ id: notificationId });
    if (!notification) {
      throw AppError.notFound('Notification not found', undefined, 'NOTIFICATION_NOT_FOUND');
    }
    if (notification.userId !== userId) {
      throw AppError.authorization(
        'You can only mark your own notifications as read',
        undefined,
        'NOT_NOTIFICATION_OWNER',
      );
    }

    if (!notification.isRead) {
      notification.isRead = true;
      return this.notificationRepo.save(notification);
    }
    return notification;
  }

  /**
   * Mark every notification of the user as read.
   *
   * @returns The number of notifications updated.
   */
  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notificationRepo.update({ userId, isRead: false }, { isRead: true });
    return { updated: result.affected ?? 0 };
  }
}
