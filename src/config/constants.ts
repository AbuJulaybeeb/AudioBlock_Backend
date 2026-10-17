/**
 * Centralized constants for AudioBlocks Backend
 *
 * All magic numbers, hardcoded strings, and configuration values
 * should be defined here with descriptive names and documentation.
 *
 * Categories:
 * - Security & Authentication
 * - Time Limits & Expiration
 * - Validation Limits
 * - HTTP Status Codes
 * - Error Messages
 * - Blockchain & Web3
 * - File Upload Limits
 */

// ============================================================================
// SECURITY & AUTHENTICATION
// ============================================================================

/** Number of bcrypt salt rounds for password hashing */
export const PASSWORD_SALT_ROUNDS = 12;

/** JWT token expiration time */
export const JWT_EXPIRATION = '1d';

/** Number of recovery codes generated for 2FA */
export const RECOVERY_CODE_COUNT = 8;

/** Number of random bytes for recovery code generation */
export const RECOVERY_CODE_BYTES = 5;

// ============================================================================
// TIME LIMITS & EXPIRATION
// ============================================================================

/** Nonce expiration time in seconds (5 minutes) */
export const NONCE_EXPIRATION_SECONDS = 300;

/** Email verification token expiration in milliseconds (24 hours) */
export const EMAIL_VERIFICATION_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/** Password reset token expiration in milliseconds (30 minutes) */
export const PASSWORD_RESET_EXPIRATION_MS = 30 * 60 * 1000;

/** Soroban transaction timeout in seconds (2 minutes) */
export const SOROBAN_TX_TIMEOUT_SECONDS = 120;

/** Soroban transaction polling interval in milliseconds */
export const SOROBAN_POLL_INTERVAL_MS = 1500;

/** Soroban transaction polling timeout in milliseconds (30 seconds) */
export const SOROBAN_POLL_TIMEOUT_MS = 30000;

// ============================================================================
// VALIDATION LIMITS
// ============================================================================

/** Minimum username length */
export const USERNAME_MIN_LENGTH = 3;

/** Maximum username length */
export const USERNAME_MAX_LENGTH = 30;

/** Minimum password length */
export const PASSWORD_MIN_LENGTH = 8;

/** Maximum password length */
export const PASSWORD_MAX_LENGTH = 128;

/** Minimum song title length */
export const SONG_TITLE_MIN_LENGTH = 1;

/** Maximum song title length */
export const SONG_TITLE_MAX_LENGTH = 200;

/** Maximum song description length */
export const SONG_DESCRIPTION_MAX_LENGTH = 5000;

/** Maximum artist bio length */
export const ARTIST_BIO_MAX_LENGTH = 2000;

/** Minimum album title length */
export const ALBUM_TITLE_MIN_LENGTH = 1;

/** Maximum album title length */
export const ALBUM_TITLE_MAX_LENGTH = 200;

/** Stellar public key length (G-address) */
export const STELLAR_PUBLIC_KEY_LENGTH = 56;

/** Stellar public key prefix */
export const STELLAR_PUBLIC_KEY_PREFIX = 'G';

/** Ethereum address length (with 0x prefix) */
export const ETHEREUM_ADDRESS_LENGTH = 42;

// ============================================================================
// HTTP STATUS CODES
// ============================================================================

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
} as const;

// ============================================================================
// ERROR MESSAGES
// ============================================================================

export const ERROR_MESSAGES = {
  // Authentication errors
  INVALID_SIGNATURE: 'Invalid signature',
  NONCE_MISSING: 'Nonce missing in message',
  NONCE_EXPIRED: 'Nonce expired',
  NONCE_MISMATCH: 'Nonce mismatch',
  INVALID_EMAIL_PASSWORD: 'Invalid email or password',
  INVALID_TWO_FACTOR_CODE: 'Invalid two-factor code',
  UNAUTHORIZED: 'Unauthorized',

  // User errors
  USER_NOT_FOUND: 'User not found',
  USER_ALREADY_EXISTS: 'User already exists',
  EMAIL_ALREADY_EXISTS: 'Email already exists',
  USERNAME_ALREADY_EXISTS: 'Username already exists',
  WALLET_ADDRESS_ALREADY_EXISTS: 'Wallet address already exists',

  // Validation errors
  EMAIL_REQUIRED: 'Email is required',
  PASSWORD_REQUIRED: 'Password is required',
  BODY_REQUIRED: 'Request body is required',
  INVALID_VERIFICATION_TOKEN: 'Invalid verification token',
  VERIFICATION_TOKEN_EXPIRED: 'Verification token has expired',
  INVALID_RESET_TOKEN: 'Invalid reset token',
  RESET_TOKEN_EXPIRED: 'Reset token has expired',

  // Blockchain errors
  WALLET_NOT_CONNECTED: 'Connect a Stellar wallet before proceeding',
  ARTIST_NOT_SETUP: 'Artist profile not set up on-chain',
  METADATA_NOT_READY: 'Song metadata not ready for minting',
  TRANSACTION_FAILED: 'Transaction failed',

  // Song errors
  SONG_NOT_FOUND: 'Song not found',
  SONG_NOT_READY: 'Song not ready',
  ALBUM_NOT_FOUND: 'Album not found',

  // File upload errors
  TEMP_DIR_NOT_FOUND: 'Temporary directory not found for fileId',
  CHUNK_COUNT_MISMATCH: 'Expected chunk count mismatch',
  FILE_UPLOAD_FAILED: 'File upload failed',

  // Generic errors
  INTERNAL_SERVER_ERROR: 'Internal server error',
  JWT_SECRET_NOT_SET: 'JWT_SECRET not set in environment variables',
  TWO_FACTOR_EMAIL_ONLY: 'Two-factor authentication is only available for email/password accounts',

  // Input validation
  INVALID_INPUT: 'Invalid input provided',
  MISSING_REQUIRED_FIELDS: 'Missing required fields',
} as const;

// ============================================================================
// SUCCESS MESSAGES
// ============================================================================

export const SUCCESS_MESSAGES = {
  USER_CREATED: 'User created successfully',
  USER_REGISTERED: 'User registered successfully',
  USER_LOGGED_IN: 'User logged in successfully',
  EMAIL_VERIFIED: 'Email verified successfully',
  PASSWORD_RESET: 'Password reset successfully',
  PASSWORD_RESET_EMAIL_SENT: 'If the email exists, a reset link has been sent',
  TWO_FACTOR_ENABLED: 'Two-factor authentication enabled',
  PROFILE_UPDATED: 'Profile updated successfully',
  SONG_UPLOADED: 'Song uploaded successfully',
  SONG_MINTED: 'Song minted successfully',
} as const;

// ============================================================================
// BLOCKCHAIN & WEB3
// ============================================================================

/** Stellar network passphrase placeholder */
export const DEFAULT_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Base fee for Stellar transactions */
export const STELLAR_BASE_FEE = '100';

/** Regular expressions for blockchain addresses */
export const BLOCKCHAIN_REGEX = {
  /** Stellar G-address pattern */
  STELLAR_PUBLIC_KEY: /^G[A-Z2-7]{55}$/,

  /** Ethereum address pattern */
  ETHEREUM_ADDRESS: /^0x[a-fA-F0-9]{40}$/,
} as const;

// ============================================================================
// REQUEST BODY SIZE LIMITS (Issue #109)
// ============================================================================

/**
 * Max size for parsed JSON request bodies (application/json), configurable
 * via JSON_BODY_LIMIT (e.g. "1mb", "500kb" — any string express.json()'s
 * `limit` option accepts). Small because JSON bodies here are metadata
 * (song details, profile fields, etc.), never raw file content — those go
 * through multer with their own per-route limits below.
 */
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? '1mb';

/**
 * Max size for parsed application/x-www-form-urlencoded bodies, configurable
 * via URLENCODED_BODY_LIMIT. Generous (50MB) to stay consistent with the
 * largest multipart file upload limit (MAX_SONG_FILE_SIZE_BYTES) in case a
 * client submits a large form field this way instead of multipart.
 */
export const URLENCODED_BODY_LIMIT = process.env.URLENCODED_BODY_LIMIT ?? '50mb';

// ============================================================================
// FILE UPLOAD LIMITS
// ============================================================================

/** Maximum file size for song uploads (100MB) */
export const MAX_SONG_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/** Maximum file size for cover art (5MB) */
export const MAX_COVER_ART_SIZE_BYTES = 5 * 1024 * 1024;

/** Allowed audio file MIME types */
export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/flac',
] as const;

/** Allowed image MIME types */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

// ============================================================================
// DATABASE & CACHING
// ============================================================================

/** Redis key prefixes */
export const REDIS_KEY_PREFIX = {
  NONCE: 'nonce:',
  SESSION: 'session:',
  MANIFEST: 'manifest:',
  USER: 'user:',
} as const;

/** Database connection pool limits */
export const DB_POOL = {
  MIN: 2,
  MAX: 10,
  ACQUIRE_TIMEOUT_MS: 30000,
  IDLE_TIMEOUT_MS: 10000,
} as const;

// ============================================================================
// RATE LIMITING
// ============================================================================

/** Rate limit window in milliseconds (15 minutes) */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Maximum requests per window */
export const RATE_LIMIT_MAX_REQUESTS = 100;

// ============================================================================
// LOGGING & MONITORING
// ============================================================================

/** Log levels */
export const LOG_LEVEL = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

// ============================================================================
// TRANSACTION ACTIONS
// ============================================================================

/** Transaction log action types */
export const TRANSACTION_ACTIONS = {
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER: 'UPDATE_USER',
  DELETE_USER: 'DELETE_USER',
  SETUP_ARTIST: 'SETUP_ARTIST',
  MINT_SONG: 'MINT_SONG',
  CREATE_ALBUM: 'CREATE_ALBUM',
  PURCHASE_SONG: 'PURCHASE_SONG',
} as const;

// ============================================================================
// SONG & ALBUM STATUS
// ============================================================================

/** Song processing status values */
export const SONG_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;

/** Song mint status values */
export const MINT_STATUS = {
  PENDING: 'pending',
  MINTING: 'minting',
  MINTED: 'minted',
  FAILED: 'failed',
} as const;

// ============================================================================
// USER ROLES
// ============================================================================

/** User role values */
export const USER_ROLES = {
  ARTIST: 'artist',
  LISTENER: 'listener',
  ADMIN: 'admin',
} as const;

// ============================================================================
// RABBITMQ QUEUES
// ============================================================================

/** RabbitMQ queue names */
export const QUEUE_NAMES = {
  SONG_PROCESSING: 'song_processing',
  SONG_TRANSCODING: 'song_transcoding',
  EMAIL_NOTIFICATION: 'email_notification',
} as const;

// ============================================================================
// REGEX PATTERNS
// ============================================================================

/** Common regex patterns for validation */
export const REGEX_PATTERNS = {
  /** Email validation */
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,

  /** Username validation (alphanumeric, underscore, hyphen) */
  USERNAME: /^[a-zA-Z0-9_-]+$/,

  /** Nonce pattern in message */
  NONCE_IN_MESSAGE: /Nonce:\s*([A-Za-z0-9-]+)/,

  /** UUID v4 pattern */
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
} as const;

// ============================================================================
// CONTROLLER METHOD LINE LIMIT
// ============================================================================

/** Maximum lines per controller method (for thin controller pattern) */
export const MAX_CONTROLLER_METHOD_LINES = 20;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get environment variable or default value
 */
export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get required environment variable or throw error
 */
export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required but not set`);
  }
  return value;
}

/**
 * Format timestamp for logs
 */
export function formatTimestamp(): string {
  return new Date().toISOString();
}

// ── Timezone & Date Handling Convention (#349) ───────────────────────────────
//
// All timestamps in this application are stored and transmitted in UTC:
//
// - Database: TypeORM's `@CreateDateColumn` and `@UpdateDateColumn` use
//   PostgreSQL's `timestamp with time zone` type, which stores UTC internally.
//   The database driver returns Date objects that serialize to UTC via
//   `toISOString()` (e.g. "2025-01-15T12:00:00.000Z").
//
// - API responses: All date fields are serialized as ISO 8601 strings with
//   explicit UTC offset ("Z" suffix) via `Date.toISOString()`. Clients should
//   parse these as UTC and convert to local time for display.
//
// - API input: Accepts ISO 8601 date strings (via `@IsDateString()` decorators).
//   Strings without explicit timezone are interpreted as UTC.
//
// - Cron/scheduled jobs: Use UTC timestamps internally. Any display-facing
//   formatting must convert to the user's local timezone explicitly.
//
// - Analytics/period boundaries: Always computed in UTC to ensure consistent
//   aggregation across all users regardless of their local timezone.
