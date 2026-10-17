import dotenv from 'dotenv';

dotenv.config();

export interface ValidatedEnv {
  NODE_ENV: string;
  PORT: string;
  POSTGRES_HOST: string;
  POSTGRES_PORT: string;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DATABASE: string;
  JWT_SECRET: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  AWS_BUCKET_NAME: string;
  SOROBAN_NETWORK: string;
  PINATA_JWT: string;
  PINATA_GATEWAY: string;
  ALLOWED_ORIGINS?: string;
  LOG_LEVEL: string;
  ERROR_DEDUP_WINDOW_MS: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  PRIVY_VERIFICATION_KEY?: string;
  // #293 — AI provider configuration per environment
  AI_PROVIDER: string;
  AI_OPENAI_API_KEY?: string;
  AI_ANTHROPIC_API_KEY?: string;
  AI_TIMEOUT_MS: string;
  // #291 — data retention controls
  AI_DATA_RETENTION_OPT_OUT: string;
}

const requiredVars: (keyof ValidatedEnv)[] = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DATABASE',
  'JWT_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_BUCKET_NAME',
  'PINATA_JWT',
  'PINATA_GATEWAY',
];

const optionalPrivyVars: (keyof ValidatedEnv)[] = [
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_VERIFICATION_KEY',
];

export function validateEnvironment(): ValidatedEnv {
  const missing: string[] = [];

  requiredVars.forEach((varName) => {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  });

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach((varName) => {
      console.error(`   - ${varName}`);
    });
    console.error('\nℹ️  Copy .env.example to .env and fill in all required values.');
    process.exit(1);
  }

  validatePrivyKeys();

  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || '4000',
    POSTGRES_HOST: process.env.POSTGRES_HOST!,
    POSTGRES_PORT: process.env.POSTGRES_PORT!,
    POSTGRES_USER: process.env.POSTGRES_USER!,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD!,
    POSTGRES_DATABASE: process.env.POSTGRES_DATABASE!,
    JWT_SECRET: process.env.JWT_SECRET!,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!,
    AWS_REGION: process.env.AWS_REGION!,
    AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME!,
    SOROBAN_NETWORK: process.env.SOROBAN_NETWORK || 'testnet',
    PINATA_JWT: process.env.PINATA_JWT!,
    PINATA_GATEWAY: process.env.PINATA_GATEWAY!,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    ERROR_DEDUP_WINDOW_MS: process.env.ERROR_DEDUP_WINDOW_MS || String(5 * 60 * 1000),
    PRIVY_APP_ID: process.env.PRIVY_APP_ID,
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET,
    PRIVY_VERIFICATION_KEY: process.env.PRIVY_VERIFICATION_KEY,
    // #293 — AI provider configuration
    AI_PROVIDER: process.env.AI_PROVIDER || 'noop',
    AI_OPENAI_API_KEY: process.env.AI_OPENAI_API_KEY,
    AI_ANTHROPIC_API_KEY: process.env.AI_ANTHROPIC_API_KEY,
    AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS || '10000',
    // #291 — data retention opt-out
    AI_DATA_RETENTION_OPT_OUT: process.env.AI_DATA_RETENTION_OPT_OUT || 'false',
  };
}

function validatePrivyKeys(): void {
  const hasAny = Boolean(
    process.env.PRIVY_APP_ID || process.env.PRIVY_APP_SECRET || process.env.PRIVY_VERIFICATION_KEY,
  );

  if (!hasAny) {
    console.warn(
      '⚠️  Privy authentication keys not configured. Privy features will not work. Set PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_VERIFICATION_KEY to enable Privy auth.',
    );
    return;
  }

  const missing: string[] = [];
  optionalPrivyVars.forEach((varName) => {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  });

  if (missing.length > 0) {
    console.error('❌ Incomplete Privy configuration. All of these must be set together:');
    optionalPrivyVars.forEach((varName) => {
      const status = process.env[varName] ? '✓' : '✗';
      console.error(`   [${status}] ${varName}`);
    });
    console.error('\nEither set all Privy keys or none at all.');
    process.exit(1);
  }
}
