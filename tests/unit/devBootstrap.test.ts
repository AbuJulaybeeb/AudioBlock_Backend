import 'reflect-metadata';
import * as childProcess from 'child_process';
import * as devBootstrap from '../../scripts/dev-bootstrap';
import AppDataSource from '../../src/config/db';
import * as seeders from '../../src/seeders';
import * as testSeeder from '../../src/seeders/test.seeder';

jest.mock('child_process', () => ({
  spawnSync: jest.fn().mockReturnValue({ status: 0 }),
}));

jest.mock('../../src/config/db', () => ({
  __esModule: true,
  default: {
    isInitialized: false,
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([{ ok: 1 }]),
    runMigrations: jest.fn().mockResolvedValue([{ name: '1719619200000-CreateInitialSchema.ts' }]),
  },
}));

jest.mock('../../src/seeders', () => ({
  runSeeders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/seeders/test.seeder', () => ({
  seedTestDatabase: jest.fn().mockResolvedValue({
    users: [{}, {}, {}, {}, {}],
    genres: [{}, {}, {}, {}, {}],
    albums: [{}, {}],
    songs: [{}, {}, {}],
  }),
}));

describe('Dev Bootstrap Script (Issue #369)', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.clearAllMocks();
    process.argv = [...originalArgv];
  });

  afterAll(() => {
    process.argv = originalArgv;
  });

  it('skips docker when --skip-docker argument is passed', () => {
    process.argv = ['node', 'dev-bootstrap.ts', '--skip-docker'];

    const result = devBootstrap.startDockerDependencies();
    expect(result).toBe(true);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('attempts to invoke docker compose up when not skipped', () => {
    process.argv = ['node', 'dev-bootstrap.ts'];

    const result = devBootstrap.startDockerDependencies();
    expect(result).toBe(true);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up', '-d', 'db', 'redis', 'rabbitmq'],
      expect.any(Object),
    );
  });

  it('waits for database and queries SELECT 1 successfully', async () => {
    await expect(devBootstrap.waitForDatabase()).resolves.toBeUndefined();
    expect(AppDataSource.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('applies migrations and reports executed migrations', async () => {
    await expect(devBootstrap.applyMigrations()).resolves.toBeUndefined();
    expect(AppDataSource.runMigrations).toHaveBeenCalled();
  });

  it('seeds genres and test database idempotently', async () => {
    await expect(devBootstrap.seedData()).resolves.toBeUndefined();
    expect(seeders.runSeeders).toHaveBeenCalled();
    expect(testSeeder.seedTestDatabase).toHaveBeenCalledWith(AppDataSource);
  });
});
