import { Router } from 'express';
import { AIStudioController, requireAiStudioEnabled } from '../controllers/AIStudioController';
import { authArtistMiddleware } from '../middlewares/authMiddleware';

const router = Router();
const controller = new AIStudioController();

router.use(authArtistMiddleware);

// Flag management is always reachable so artists can opt in/out.
router.get('/status', controller.getStatus);
router.patch('/status', controller.setEnabled);

// All AI-assisted upload tools below require the per-artist enable flag.
router.use(requireAiStudioEnabled);
router.get('/overview', controller.getOverview);
router.post('/songs/:songId/cover-art', controller.requestCoverArt);
router.post('/songs/:songId/description', controller.requestDescription);
router.post('/songs/:songId/lyrics-transcription', controller.requestLyricsTranscription);
router.post('/suggest-tags', controller.suggestTags);
router.post('/tweet-draft', controller.createTweetDraft);

export default router;
