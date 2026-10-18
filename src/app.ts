import cookieParser from "cookie-parser";
import express, {
  Request,
  Response,
  RequestHandler,
  ErrorRequestHandler,
} from "express";
import logger from "./config/logger";
import { requestLoggerMiddleware } from "./middlewares/requestLogger";
import { sanitizeInput } from "./middlewares/sanitizeInput";
import cors from "cors";
import authRoutes from "./routes/authRoutes";
import artistRoutes from "./routes/artistRoutes";
import twitterRoutes from "./routes/twitterRoutes";
import walletRoutes from "./routes/walletRoutes";
import SongRoutes from "./routes/SongRoutes";
import marketplaceRoutes from "./routes/marketplaceRoutes";
import adminRoutes from "./routes/adminRoutes";
import webhookRoutes from "./routes/webhookRoutes";
import takedownRoutes from "./routes/takedownRoutes";
import embedRoutes from "./routes/embedRoutes";
import oembedRoutes from "./routes/oembedRoutes";
import royaltyPayoutRoutes from "./routes/royaltyPayoutRoutes";
import playlistRoutes from "./routes/playlistRoutes";
import userRoutes from "./routes/userRoutes";
import commentRoutes from "./routes/commentRoutes";
import commentReactionRoutes from "./routes/commentReactionRoutes";
import subscriptionRoutes from "./routes/subscriptionRoutes";
import aiRoutes from "./routes/aiRoutes";
import aiStudioRoutes from "./routes/aiStudioRoutes";
import activityRoutes from "./routes/activityRoutes";
import activityStreamRoutes from "./routes/activityStreamRoutes";
import accountRoutes from "./routes/accountRoutes";
import metricsRoutes from "./routes/metricsRoutes";
import privyWebhookRoutes from "./routes/privyWebhookRoutes";
import accountTypeRoutes from "./routes/accountTypeRoutes";
import healthRoutes from "./routes/healthRoutes";

// Route imports

// Initialize express app
const app = express();

// Apply middleware
// Apply global middlewares
app.use(cookieParser());
// Structured request logging with correlation id (Issue #33)
app.use(requestLoggerMiddleware);

// CORS configuration
// In production set ALLOWED_ORIGINS to a comma-separated list of the deployed
// listener-app and artist-dashboard domains, e.g.:
//   ALLOWED_ORIGINS=https://listener.audioblockz.com,https://artist.audioblockz.com
const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:5500"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
    ],
    exposedHeaders: ["Authorization"],
    maxAge: 86400, // 24 hours
  }),
);

app.use(express.json());

// Sanitize free-text fields in every JSON request body (issue #327).
// sanitizeInput itself already no-ops for multipart/binary uploads and
// non-object bodies, so applying it globally — after express.json() parses
// the body, before any route sees it — is safe and is the only way to
// guarantee every current and future free-text route (comments, bios,
// report reasons, playlist names, ...) is covered without relying on each
// route file to remember to wire it in individually. It was previously
// defined but applied to zero routes.
app.use(sanitizeInput);

// Add timeout configurations
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 seconds
  res.setTimeout(30000); // 30 seconds
  next();
});



// Log application startup


// Define routes
app.use("/health", healthRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/artist", artistRoutes);

// Dynamic wallet routes
app.use("/api/wallet", walletRoutes);

// Song wallet
app.use("/api/song", SongRoutes);

// Marketplace Soroban relay (list + buy)
app.use("/api/marketplace", marketplaceRoutes);

// Royalty payouts
app.use("/api/royalty-payouts", royaltyPayoutRoutes);

// Admin moderation routes
app.use("/api/admin", adminRoutes);

// Webhook subscriptions (third-party event delivery)
app.use("/api/webhooks", webhookRoutes);

// Copyright takedown workflow (distinct from general moderation)
app.use("/api/takedown", takedownRoutes);

// Embeddable player (public, no auth)
app.use("/api/embed", embedRoutes);

// oEmbed provider endpoint for rich link previews (public, no auth)
app.use("/api/oembed", oembedRoutes);


// Playlists (Issue #77) + collaborative editing (#406) + smart playlists (#407)
app.use("/api/playlists", playlistRoutes);

// User routes
app.use("/api/users", userRoutes);


//TWITTER CALLBACK ROUTE
app.use("/api/auth/twitter", twitterRoutes);

// Song comments + replies (Issue #90)
app.use("/api/comments", commentRoutes);

// Comment reactions: like, heart, fire (Issue #412)
app.use("/api/comments", commentReactionRoutes);

// Subscriptions: tiered plans, gifting, trial periods (Issues #413, #414, #415, #416)
app.use("/api/subscriptions", subscriptionRoutes);

// AI-assisted generation (cover art, descriptions) — async, queued via JobQueueService
app.use("/api/ai", aiRoutes);

// AI Studio: grouped AI-assisted upload tools, gated by per-artist enable flag
app.use("/api/ai-studio", aiStudioRoutes);

// On-chain activity & feeds (REST queries + live SSE stream)
app.use("/api/activity", activityRoutes);
app.use("/api/activity", activityStreamRoutes);

// GDPR account lifecycle: data export, deletion request/cancel, status (#633)
app.use("/api/account", accountRoutes);

// Privy webhooks: embedded wallet, Stellar linking, profile sync (#603-606, #612, #614)
app.use("/api", privyWebhookRoutes);

// Account type management: artist vs listener distinction (#616)
app.use("/api", accountTypeRoutes);

app.use("/metrics", metricsRoutes);

// Error handling middleware
const customErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error(
    { reqId: (req as any).id, err, route: req.originalUrl, method: req.method },
    "Unhandled error"
  );

  // Multer file-size limit exceeded
  if (err.name === "MulterError" && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "Uploaded file exceeds the maximum allowed size.",
      type: "VALIDATION_FAILED",
    });
  }

  // Other multer errors (file filter rejections, unexpected fields, etc.)
  if (err.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message: err.message,
      type: "VALIDATION_FAILED",
    });
  }

  // File filter rejection errors are passed as plain Error through Express
  if (err instanceof Error && /Invalid file type|allowed/i.test(err.message)) {
    return res.status(400).json({
      success: false,
      message: err.message,
      type: "VALIDATION_FAILED",
    });
  }

  res.status(500).json({
    success: false,
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
    type: "INTERNAL_ERROR",
  });
};

app.use(customErrorHandler);

// Handle 404 errors
app.use(((req: Request, res: Response) => {
  logger.warn({ reqId: (req as any).id, route: req.originalUrl }, "404 - Route not found");
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    type: "NOT_FOUND",
  });
}) as RequestHandler);

// Export app
export default app;
