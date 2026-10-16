import { Router } from 'express';
import { AiController } from '../controllers/AiController';
import { authArtistMiddleware } from '../middlewares/authMiddleware';

const router = Router();
const aiController = new AiController();

router.use(authArtistMiddleware);

router.post('/songs/:songId/cover-art', aiController.requestCoverArt);
router.post('/songs/:songId/description', aiController.requestDescription);
router.post('/songs/:songId/lyrics-transcription', aiController.requestLyricsTranscription);
router.get('/generations/:id', aiController.getGeneration);

export default router;
