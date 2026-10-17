import { Router } from 'express';
import { UploadController } from '../controllers/UploadController';
import { validateDTO } from '../middlewares/validate';
import { FinalizeUploadDTO } from '../dtos/FinalizeUploadDTO';
import { UploadChunkDTO } from '../dtos/UploadChunkDTO';
import { authArtistMiddleware } from '../middlewares/authMiddleware';
import multer from 'multer';
import { CreateCoverDTO } from '../dtos/CreateCoverDTO';
import fs from 'fs';
import { SongController } from '../controllers/SongController';
import { EmbedController } from '../controllers/EmbedController';
import { SubmitSignedXdrDTO } from '../dtos/SubmitSignedXdrDTO';
import { idempotency } from '../middlewares/idempotency';

const uploadController = new UploadController();
const router = Router();
// const upload = multer({ dest: "uploads/chunks/" });

// ── Chunked upload limits (#63) ───────────────────────────────────────────────
//
// Chunk size:   The backend imposes no per-chunk byte limit here (multer uses
//               memoryStorage default of 1 MB when no limit is set, but disk
//               storage has no default cap).  The artist-dashboard uploader
//               currently sends 5 MB chunks (CHUNK_SIZE = 5 * 1024 * 1024).
//               If you need to enforce a server-side cap, set:
//                 multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })
//
// Concurrency: The artist-dashboard serialises chunk uploads (one at a time)
//               so the server never receives parallel chunk requests for the
//               same fileId.  Re-ordering is handled by chunkIndex in the
//               finalize step.  If the frontend uploader changes to parallel
//               uploads, add a per-fileId in-flight counter here.
//
// Max file:    Total audio file size is not bounded at the chunk layer.
//               Add a per-session size accumulator in saveChunk() if you need
//               to enforce a maximum.
const CHUNK_MAX_SIZE_BYTES = process.env.CHUNK_UPLOAD_MAX_BYTES
  ? Number(process.env.CHUNK_UPLOAD_MAX_BYTES)
  : 10 * 1024 * 1024; // 10 MB per chunk (safety cap), configurable via CHUNK_UPLOAD_MAX_BYTES

const ALLOWED_AUDIO_MIMES = [
  'audio/mpeg', // .mp3
  'audio/wav', // .wav
  'audio/x-wav', // .wav (alt)
  'audio/flac', // .flac
  'audio/x-flac', // .flac (alt)
  'audio/ogg', // .ogg
  'audio/aac', // .aac
  'audio/mp4', // .m4a
  'audio/x-m4a', // .m4a (alt)
  'audio/webm', // .webm
];

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/jpg'];

const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/temp';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(7)}`);
  },
});

const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/temp';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(7)}`);
  },
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: CHUNK_MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
      return cb(
        new Error('Invalid file type. Allowed audio formats: MP3, WAV, FLAC, OGG, AAC, M4A, WebM'),
      );
    }
    cb(null, true);
  },
});

const coverUpload = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB for cover images
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Allowed image formats: JPG, PNG'));
    }
    cb(null, true);
  },
});
// const upload = multer({ dest: "uploads/temp/" });
router.post(
  '/upload/chunk',
  authArtistMiddleware,
  chunkUpload.single('chunk'),
  validateDTO(UploadChunkDTO),
  uploadController.uploadChunk,
);
router.post(
  '/upload/cover',
  authArtistMiddleware,
  coverUpload.single('cover'),
  validateDTO(CreateCoverDTO),
  uploadController.uploadCover,
);
router.post(
  '/upload/finalize',
  authArtistMiddleware,
  idempotency(),
  validateDTO(FinalizeUploadDTO),
  uploadController.finalizeUpload,
);
router.post('/upload/suggest-tags', authArtistMiddleware, uploadController.suggestTagsAndGenres);

// Stream Songs
router.get('/stream/:id', SongController.streamSong);
router.get('/popular', SongController.getPopularSongs);

// Embeddable player endpoint — public, no auth, same rate limiting as streaming (Redis throttle)
router.get('/embed/:id', EmbedController.getSongEmbed);

// Soroban on-chain song minting: the artist's wallet signs, the backend
// only builds and relays the transaction.
router.post('/:id/onchain/prepare-mint', authArtistMiddleware, idempotency(), SongController.prepareMint);
router.post(
  '/:id/onchain/submit-mint',
  authArtistMiddleware,
  idempotency(),
  validateDTO(SubmitSignedXdrDTO),
  SongController.submitMint,
);

// Collaborator dispute endpoints
router.post('/:id/collaborators/dispute', authArtistMiddleware, SongController.disputeSplit);
router.post(
  '/:id/collaborators/:userId/resolve-dispute',
  authArtistMiddleware,
  SongController.resolveDispute,
);

export default router;
