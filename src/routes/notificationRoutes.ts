import { Router } from 'express';
import { NotificationController } from '../controllers/NotificationController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();

// Notifications are personal, so every route requires authentication (Issue #79).
router.get('/', requireAuth, NotificationController.list);
router.put('/:id/read', requireAuth, NotificationController.markAsRead);
router.post('/read-all', requireAuth, NotificationController.markAllAsRead);

// Device token management for push notifications (Issue #429)
router.post('/device-token', requireAuth, NotificationController.registerDeviceToken);
router.delete('/device-token', requireAuth, NotificationController.removeDeviceToken);

export default router;
