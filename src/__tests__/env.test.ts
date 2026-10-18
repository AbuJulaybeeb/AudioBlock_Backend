import { validateEnvironment } from '../config/env';

const baseEnv = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'test_user',
  POSTGRES_PASSWORD: 'test_password',
  POSTGRES_DATABASE: 'test_db',
  JWT_SECRET: 'test_jwt_secret',
  AWS_ACCESS_KEY_ID: 'test_aws_key',
  AWS_SECRET_ACCESS_KEY: 'test_aws_secret',
  AWS_REGION: 'us-east-1',
  AWS_BUCKET_NAME: 'test_bucket',
  PINATA_JWT: 'test_pinata_jwt',
  PINATA_GATEWAY: 'https://gateway.pinata.cloud',
};

describe('validateEnvironment - production mode (#793)', () => {
  const originalEnv = { ...process.env };
  let mockExit: jest.SpyInstance;
  let mockError: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, ...baseEnv, NODE_ENV: 'production' };
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    delete process.env.PRIVY_VERIFICATION_KEY;
    mockExit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as () => never);
    mockError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('fails boot in production if LISTENER_KEY_SALT is missing', () => {
    delete process.env.LISTENER_KEY_SALT;
    validateEnvironment();
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('LISTENER_KEY_SALT'));
  });

  it('succeeds in production when LISTENER_KEY_SALT is provided', () => {
    process.env.LISTENER_KEY_SALT = 'super-secret-production-salt-key';
    const env = validateEnvironment();
    expect(mockExit).not.toHaveBeenCalled();
    expect(env.LISTENER_KEY_SALT).toBe('super-secret-production-salt-key');
  });
});

describe('validateEnvironment - development mode (#793)', () => {
  const originalEnv = { ...process.env };
  let mockExit: jest.SpyInstance;
  let mockWarn: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, ...baseEnv, NODE_ENV: 'development' };
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    delete process.env.PRIVY_VERIFICATION_KEY;
    delete process.env.LISTENER_KEY_SALT;
    mockExit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as () => never);
    mockWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mockExit.mockRestore();
    mockWarn.mockRestore();
  });

  it('warns in development if LISTENER_KEY_SALT is missing', () => {
    const env = validateEnvironment();
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('LISTENER_KEY_SALT is not set'));
    expect(env.LISTENER_KEY_SALT).toBeUndefined();
  });
});
