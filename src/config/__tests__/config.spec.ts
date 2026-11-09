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

describe('KYC_PROVIDER', () => {
  it('defaults to fake and needs no Prembly key', () => {
    const config = loadConfig(baseEnv());

    expect(config.kyc.provider).toBe('fake');
    expect(config.kyc.prembly.secretKey).toBeUndefined();
  });

  it('requires PREMBLY_SECRET_KEY when prembly is selected', () => {
    expect(() => loadConfig({ ...baseEnv(), KYC_PROVIDER: 'prembly' })).toThrow(
      'PREMBLY_SECRET_KEY',
    );
  });

  it('exposes the Prembly key when prembly is selected', () => {
    const config = loadConfig({
      ...baseEnv(),
      KYC_PROVIDER: 'prembly',
      PREMBLY_SECRET_KEY: 'key-1',
    });

    expect(config.kyc.provider).toBe('prembly');
    expect(config.kyc.prembly.secretKey).toBe('key-1');
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ ...baseEnv(), KYC_PROVIDER: 'dojah' })).toThrow(
      'KYC_PROVIDER',
    );
  });

  it('blocks fake in production', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        NODE_ENV: 'production',
        KYC_PROVIDER: 'fake',
      }),
    ).toThrow('must not be "fake" in production');
  });
});

describe('scheduled payments', () => {
  it('defaults to a 06:00 Lagos window of 240 minutes', () => {
    expect(loadConfig(baseEnv()).scheduledPayments).toEqual({
      sweepIntervalMs: 60_000,
      workerConcurrency: 5,
      windowStart: '06:00',
      windowMinutes: 240,
      maxActive: 20,
    });
  });

  it('rejects a window start that is not HH:MM', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), SCHEDULED_PAYMENT_WINDOW_START: '6am' }),
    ).toThrow('SCHEDULED_PAYMENT_WINDOW_START');
  });
});

describe('device binding', () => {
  it('requires device keys and shadows attestation by default', () => {
    const config = loadConfig(baseEnv());

    expect(config.device.keyRequired).toBe(true);
    expect(config.device.attestation.mode).toBe('shadow');
    expect(config.device.attestation.provider).toBe('fake');
  });

  it('allows DEVICE_KEY_REQUIRED=false outside production', () => {
    expect(
      loadConfig({ ...baseEnv(), DEVICE_KEY_REQUIRED: 'false' }).device
        .keyRequired,
    ).toBe(false);
  });

  it('refuses DEVICE_KEY_REQUIRED=false in production', () => {
    expect(() =>
      loadConfig({
        ...productionEnv(),
        DEVICE_KEY_REQUIRED: 'false',
      }),
    ).toThrow('DEVICE_KEY_REQUIRED must not be "false" in production');
  });

  it('refuses the fake attestation provider in production unless attestation is off', () => {
    expect(() =>
      loadConfig({ ...productionEnv(), DEVICE_ATTESTATION_PROVIDER: 'fake' }),
    ).toThrow('DEVICE_ATTESTATION_PROVIDER');
    expect(
      loadConfig({
        ...productionEnv(),
        DEVICE_ATTESTATION_PROVIDER: 'fake',
        DEVICE_ATTESTATION_MODE: 'off',
      }).device.attestation.mode,
    ).toBe('off');
  });

  it('requires the Apple and Google settings for the platform provider', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), DEVICE_ATTESTATION_PROVIDER: 'platform' }),
    ).toThrow('APPLE_TEAM_ID');
  });
});

function productionEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'kora',
    KORA_SECRET_KEY: 'k',
    KORA_WEBHOOK_URL: 'https://example.com/hook',
    PAYMENT_REDIRECT_URL: 'https://example.com/back',
    KYC_PROVIDER: 'prembly',
    PREMBLY_SECRET_KEY: 'p',
  };
}
