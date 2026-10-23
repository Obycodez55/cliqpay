import { loadConfig } from '..';

const baseEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://user:password@localhost:5432/cliqpay',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit-test-jwt-secret-at-least-32-characters',
  ENCRYPTION_KEY: '0'.repeat(64),
  TRANSACTION_PIN_PEPPER: '1'.repeat(64),
  IDENTIFIER_HASH_KEY: '3'.repeat(64),
  RECONCILIATION_ALERT_EMAIL: 'ops@cliqpay.test',
  INTERNAL_API_SECRET: '2'.repeat(64),
});

describe('IDENTIFIER_HASH_KEY', () => {
  it('is exposed as identifierHash.key', () => {
    expect(loadConfig(baseEnv()).identifierHash.key).toBe('3'.repeat(64));
  });

  it('is required', () => {
    const env = baseEnv();
    delete env.IDENTIFIER_HASH_KEY;

    expect(() => loadConfig(env)).toThrow('IDENTIFIER_HASH_KEY');
  });

  it('must be 64 hex characters', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IDENTIFIER_HASH_KEY: 'z'.repeat(64) }),
    ).toThrow('64-character hex');
    expect(() =>
      loadConfig({ ...baseEnv(), IDENTIFIER_HASH_KEY: '3'.repeat(32) }),
    ).toThrow('64-character hex');
  });

  it('must differ from ENCRYPTION_KEY, ignoring case', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ENCRYPTION_KEY: 'ab'.repeat(32),
        IDENTIFIER_HASH_KEY: 'AB'.repeat(32),
      }),
    ).toThrow('must differ from ENCRYPTION_KEY');
  });

  it('must differ from TRANSACTION_PIN_PEPPER, ignoring case', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        TRANSACTION_PIN_PEPPER: 'cd'.repeat(32),
        IDENTIFIER_HASH_KEY: 'CD'.repeat(32),
      }),
    ).toThrow('must differ from TRANSACTION_PIN_PEPPER');
  });
});

describe('KYC_RETENTION_DAYS', () => {
  it('defaults to 30 days', () => {
    expect(loadConfig(baseEnv()).kyc.retentionDays).toBe(30);
  });

  it('cannot be set below the 24-hour rate-limit window', () => {
    expect(() => loadConfig({ ...baseEnv(), KYC_RETENTION_DAYS: '1' })).toThrow(
      'KYC_RETENTION_DAYS',
    );
    expect(
      loadConfig({ ...baseEnv(), KYC_RETENTION_DAYS: '2' }).kyc.retentionDays,
    ).toBe(2);
  });
});
