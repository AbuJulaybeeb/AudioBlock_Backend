import { Router } from 'express';
import { OEmbedController } from '../controllers/OEmbedController';
import { etagCache } from '../middlewares/etag';

const router = Router();

// Public oEmbed provider endpoint (https://oembed.com/) — no auth required
router.get('/', etagCache({ visibility: 'public', maxAge: 300 }), OEmbedController.getOEmbed);

export default router;
