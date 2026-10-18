import { Router } from 'express';
import { HealthController } from '../controllers/HealthController';
import { requireRoles } from '../middlewares/authMiddleware';
import { UserRole } from '../entities/User';

const router = Router();

// Base health endpoint: returns 200 ok
router.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Liveness: process is up. No dependency checks — used for restart decisions.
router.get('/live', HealthController.live);

// Readiness: dependencies (DB, Redis if configured, Pinata) are reachable.
// Used to gate traffic at the load balancer / k8s service level.
router.get('/ready', HealthController.ready);

// Song-processing worker consumer status and stale detection (Issue #356)
router.get('/worker', HealthController.worker);

// Full dependency + pool report, admin only.
router.get('/detailed', requireRoles(UserRole.ADMIN), HealthController.detailed);

export default router;
