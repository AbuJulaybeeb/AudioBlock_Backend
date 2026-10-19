import { Request, Response } from 'express';
import { NotificationService } from '../services/NotificationService';
import { handleError } from '../utils/helpers';

const notificationService = new NotificationService();

export class NotificationController {
  /** GET /api/notifications — the caller's notifications, paginated. */
  static list = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as string;
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      const result = await notificationService.listForUser(userId, page, limit);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** PUT /api/notifications/:id/read — mark one notification as read. */
  static markAsRead = async (req: Request, res: Response) => {
    try {
      const notificationId = req.params.id as string;
      const userId = (req as any).user.id as string;

      const notification = await notificationService.markAsRead(notificationId, userId);
      return res.status(200).json({ success: true, data: notification });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** POST /api/notifications/read-all — mark every notification as read. */
  static markAllAsRead = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as string;

      const result = await notificationService.markAllAsRead(userId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** POST /api/notifications/device-token — register a device token for push delivery (Issue #429). */
  static registerDeviceToken = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as string;
      const { token, platform } = req.body || {};

      const deviceToken = await notificationService.registerDeviceToken(userId, token, platform);
      return res.status(200).json({ success: true, data: deviceToken });
    } catch (error) {
      handleError(req, res, error);
    }
  };

  /** DELETE /api/notifications/device-token — remove a device token (Issue #429). */
  static removeDeviceToken = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as string;
      const token = (req.body?.token || req.query?.token) as string;

      const removed = await notificationService.removeDeviceToken(userId, token);
      return res.status(200).json({ success: true, removed });
    } catch (error) {
      handleError(req, res, error);
    }
  };
}
