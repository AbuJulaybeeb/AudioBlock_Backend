/**
 * Full Local Stack Bootstrap & Seeder Script (Issue #369)
 * ──────────────────────────────────────────────────────────
 * Automatically orchestrates a working local developer environment in one command:
 *   1. Starts database and queue dependencies via Docker Compose (db, redis, rabbitmq)
 *   2. Waits for PostgreSQL readiness with backoff polling
 *   3. Applies all pending TypeORM migrations
 *   4. Runs genre seeders
 *   5. Seeds representative test users (admin, artists, listeners), albums, and songs
 *
 * This command is completely IDEMPOTENT: running it multiple times safely re-verifies
 * database state without throwing duplicate constraint errors or corrupting data.
 *
 * Usage:
 *   npm run dev:bootstrap
 *   or:
 *   npx ts-node scripts/dev-bootstrap.ts [--skip-docker]
 */

import 'reflect-metadata';
import dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import AppDataSource from '../src/config/db';
import { runSeeders } from '../src/seeders';
import { seedTestDatabase } from '../src/seeders/test.seeder';
import logger from '../src/config/logger';

dotenv.config();

const MAX_DB_WAIT_RETRIES = 15;
const DB_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to start container services via Docker Compose
 */
export function startDockerDependencies(): boolean {
  const skipDocker = process.argv.includes('--skip-docker') || process.env.SKIP_DOCKER === 'true';
  if (skipDocker) {
    console.log('⏩ Skipping Docker Compose startup (--skip-docker flag detected)');
    return true;
  }

  console.log('🐳 Checking Docker Compose dependencies (db, redis, rabbitmq)...');
  try {
    const res = spawnSync('docker', ['compose', 'up', '-d', 'db', 'redis', 'rabbitmq'], {
      stdio: 'inherit',
      encoding: 'utf-8',
    });

    if (res.status === 0) {
      console.log('✅ Docker containers started successfully');
      return true;
    } else {
      console.warn('⚠️  Docker Compose exited with code', res.status, '- attempting to connect to existing local database services...');
      return false;
    }
  } catch (err: any) {
    console.warn(`⚠️  Docker CLI not available (${err?.message}) - proceeding with direct database connection...`);
    return false;
  }
}

/**
 * Polls PostgreSQL database until it accepts connections
 */
export async function waitForDatabase(): Promise<void> {
  console.log('⏳ Connecting to PostgreSQL database...');

  for (let attempt = 1; attempt <= MAX_DB_WAIT_RETRIES; attempt++) {
    try {
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
      }
      await AppDataSource.query('SELECT 1');
      console.log('✅ Database connected and ready to accept queries');
      return;
    } catch (err: any) {
      if (attempt === MAX_DB_WAIT_RETRIES) {
        console.error(`❌ Database failed to become ready after ${MAX_DB_WAIT_RETRIES} attempts: ${err?.message}`);
        throw err;
      }
      console.log(`   [Attempt ${attempt}/${MAX_DB_WAIT_RETRIES}] Database not ready yet, retrying in ${DB_RETRY_DELAY_MS / 1000}s...`);
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

/**
 * Executes all pending database schema migrations
 */
export async function applyMigrations(): Promise<void> {
  console.log('🔄 Running database schema migrations...');
  try {
    const executedMigrations = await AppDataSource.runMigrations();
    if (executedMigrations.length > 0) {
      console.log(`✅ Applied ${executedMigrations.length} migration(s):`);
      executedMigrations.forEach((m) => console.log(`   - ${m.name}`));
    } else {
      console.log('✅ Database schema is already up-to-date (0 pending migrations)');
    }
  } catch (err: any) {
    console.error('❌ Migration execution failed:', err?.message);
    throw err;
  }
}

/**
 * Seeds genre lookup records and test development data
 */
export async function seedData(): Promise<void> {
  console.log('🌱 Seeding genres...');
  await runSeeders();
  console.log('✅ Genres verified');

  console.log('👥 Seeding test users, artists, albums, and tracks...');
  process.env.ALLOW_TEST_SEED = 'true';
  const testData = await seedTestDatabase(AppDataSource);
  console.log('✅ Seed data successfully verified:');
  console.log(`   - ${testData.users.length} Users (Admin, Artists, Listeners)`);
  console.log(`   - ${testData.genres.length} Genres`);
  console.log(`   - ${testData.albums.length} Albums`);
  console.log(`   - ${testData.songs.length} Songs`);
}

/**
 * Main orchestration entry point
 */
export async function bootstrap(): Promise<void> {
  const startTime = Date.now();
  console.log('\n======================================================');
  console.log('🚀 AudioBlocks Local Stack Bootstrap (Issue #369)');
  console.log('======================================================\n');

  try {
    startDockerDependencies();
    await waitForDatabase();
    await applyMigrations();
    await seedData();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n======================================================');
    console.log(`🎉 Bootstrap completed successfully in ${elapsed}s!`);
    console.log('======================================================');
    console.log('\n🔑 Test Accounts Seeded:');
    console.log('   - Admin:      admin@audioblocks.test     (Password: Password123!)');
    console.log('   - Artist 1:   artist1@audioblocks.test   (Password: Password123!)');
    console.log('   - Artist 2:   artist2@audioblocks.test   (Password: Password123!)');
    console.log('   - Listener 1: listener1@audioblocks.test (Password: Password123!)');
    console.log('   - Listener 2: listener2@audioblocks.test (Password: Password123!)');
    console.log('\n🚀 Next Step:');
    console.log('   Start the local development server:');
    console.log('   npm run dev\n');
  } catch (err: any) {
    console.error('\n❌ Bootstrap failed with error:', err?.message || err);
    process.exit(1);
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

if (require.main === module) {
  bootstrap();
}
