import { DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../../../src/config';

export const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
export const TEST_ENCRYPTION_KEY = 'a'.repeat(64);
export const TEST_PIN_PEPPER = 'b'.repeat(64);

function defaultTestAppConfig(): AppConfig {
  return {
    app: { env: 'test', port: 0, corsAllowedOrigins: [] },
    database: { url: '' },
    redis: { url: 'redis://localhost:6379' },
    sentry: { dsn: undefined },
    rateLimit: { ttlMs: 60_000, limit: 100 },
    jwt: { secret: TEST_JWT_SECRET },
    encryption: { key: TEST_ENCRYPTION_KEY },
    transactionPin: { pepper: TEST_PIN_PEPPER },
    notifications: {
      emailProvider: 'fake',
      smsProvider: 'fake',
      pushProvider: 'fake',
      brevo: {
        apiKey: undefined,
        senderEmail: undefined,
        senderName: undefined,
      },
      termii: { apiKey: undefined, senderId: undefined },
      firebase: {
        projectId: undefined,
        clientEmail: undefined,
        privateKey: undefined,
      },
      retentionDays: 180,
    },
    payments: {
      provider: 'fake',
      kora: {
        secretKey: undefined,
        webhookUrl: undefined,
        redirectUrl: undefined,
      },
      reconciliation: { alertEmail: 'ops@cliqpay.test' },
    },
    transfers: { platformFee: 0, minAmount: 10_000, maxAmount: 100_000_000 },
    moneyRequests: { expiryDays: 7, maxPendingPerPair: 3 },
    withdrawals: {
      minAmount: 10_000,
      maxAmount: 100_000_000,
      platformFee: 0,
      providerFee: 3_000,
    },
  };
}

// Every existing test context only ever replaces a whole top-level
// namespace (`database`, `redis`, `transfers`, ...), never a single nested
// field within one — so a shallow merge covers every real case without the
// extra complexity of a deep merge. `database`/`redis` are always passed:
// they depend on that suite's own container ports, which don't exist until
// the container has started.
export function buildTestAppConfig(
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return { ...defaultTestAppConfig(), ...overrides };
}

@Module({})
class TestConfigModule {}

export function buildTestConfigModule(config: AppConfig): DynamicModule {
  return {
    module: TestConfigModule,
    global: true,
    providers: [{ provide: APP_CONFIG, useValue: config }],
    exports: [APP_CONFIG],
  };
}

// Mirrors AppModule's single global JwtModule registration. Test contexts
// assemble their own ad hoc module list instead of importing AppModule, so
// each needs this once — same reasoning, same place to change if the JWT
// config ever needs more than a bare secret.
export function buildTestJwtModule(): DynamicModule {
  return JwtModule.registerAsync({
    global: true,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
  });
}
