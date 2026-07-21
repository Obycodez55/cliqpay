import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { EventBusModule } from '../../src/shared/events/event-bus.module';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { EMAIL_SENDER } from '../../src/modules/notifications/channels/email/email-sender.interface';
import { PUSH_SENDER } from '../../src/modules/notifications/channels/push/push-sender.interface';
import { FakeEmailAdapter } from '../../src/modules/notifications/channels/email/fake-email.adapter';
import { FakePushAdapter } from '../../src/modules/notifications/channels/push/fake-push.adapter';
import { PushToken } from '../../src/modules/notifications/entities/push-token.entity';
import { CreatePushTokens1784616220824 } from '../../src/database/migrations/1784616220824-CreatePushTokens';

jest.setTimeout(120_000);

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const USER_3 = '33333333-3333-4333-8333-333333333333';
const USER_4 = '44444444-4444-4444-8444-444444444444';
const USER_5 = '55555555-5555-4555-8555-555555555555';
const USER_6 = '66666666-6666-4666-8666-666666666666';

@Module({})
class TestConfigModule {}

function buildTestConfigModule(config: AppConfig): DynamicModule {
  return {
    module: TestConfigModule,
    global: true,
    providers: [{ provide: APP_CONFIG, useValue: config }],
    exports: [APP_CONFIG],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// End-to-end dispatch against the fake adapters — a real Postgres and a
// real Redis, per docs/architecture.md §10, not mocks. Proves both dispatch
// paths (fire-and-forget via the domain event bus, and the synchronous
// awaited OTP path) work through the actual BullMQ queues, not just through
// NotificationService called directly (that's unit-tested separately).
describe('Notifications module — end-to-end dispatch', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let notificationService: NotificationService;
  let eventBus: EventBusService;
  let emailAdapter: FakeEmailAdapter;
  let pushAdapter: FakePushAdapter;
  let pushTokens: Repository<PushToken>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    const setupDataSource = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      synchronize: false,
    });
    await setupDataSource.initialize();
    const queryRunner = setupDataSource.createQueryRunner();
    await new CreatePushTokens1784616220824().up(queryRunner);
    await queryRunner.release();
    await setupDataSource.destroy();

    const config: AppConfig = {
      app: { env: 'test', port: 0, corsAllowedOrigins: [] },
      database: { url: postgres.getConnectionUri() },
      redis: {
        url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
      sentry: { dsn: undefined },
      rateLimit: { ttlMs: 60_000, limit: 100 },
      jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
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
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildTestConfigModule(config),
        TypeOrmModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (cfg: AppConfig) => buildDataSourceOptions(cfg),
        }),
        EventBusModule,
        NotificationsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    notificationService = moduleRef.get(NotificationService);
    eventBus = moduleRef.get(EventBusService);
    emailAdapter = moduleRef.get(EMAIL_SENDER);
    pushAdapter = moduleRef.get(PUSH_SENDER);
    pushTokens = moduleRef.get(getRepositoryToken(PushToken));
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  it('dispatches a fire-and-forget event through the real domain events queue', async () => {
    const before = emailAdapter.sent.length;
    await eventBus.publish({
      name: 'security_alert',
      payload: {
        userId: USER_1,
        email: 'user-1@example.com',
        message: 'New device login',
      },
      occurredAt: new Date(),
    });

    await waitFor(() => emailAdapter.sent.length > before);
    expect(emailAdapter.sent.at(-1)).toMatchObject({
      to: 'user-1@example.com',
    });
  });

  it('awaits an OTP send through the synchronous priority-queue path', async () => {
    await expect(
      eventBus.dispatchAndAwait({
        name: 'email_verification_otp',
        payload: {
          userId: USER_2,
          email: 'user-2@example.com',
          code: '654321',
          expiresInMinutes: 10,
        },
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    expect(emailAdapter.sent.some((m) => m.to === 'user-2@example.com')).toBe(
      true,
    );
  });

  it('rejects promptly (not by exhausting the ~5s timeout) on a permanent OTP delivery failure', async () => {
    const startedAt = Date.now();
    await expect(
      eventBus.dispatchAndAwait({
        name: 'password_reset_otp',
        payload: {
          userId: USER_3,
          email: 'user-3+fail-permanent@example.com',
          code: '111111',
          expiresInMinutes: 10,
        },
        occurredAt: new Date(),
      }),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('upserts a push token on register and reassigns it on re-registration under a new user', async () => {
    await notificationService.registerPushToken(
      USER_4,
      'android',
      'shared-device-token',
    );
    let row = await pushTokens.findOne({
      where: { token: 'shared-device-token' },
    });
    expect(row?.userId).toBe(USER_4);

    await notificationService.registerPushToken(
      USER_5,
      'android',
      'shared-device-token',
    );
    row = await pushTokens.findOne({
      where: { token: 'shared-device-token' },
    });
    expect(row?.userId).toBe(USER_5);

    const all = await pushTokens.find({
      where: { token: 'shared-device-token' },
    });
    expect(all).toHaveLength(1);
  });

  it('delivers to every registered push token for a multi-channel notification', async () => {
    await notificationService.registerPushToken(USER_6, 'ios', 'user-6-device');

    await notificationService.send('security_alert', {
      userId: USER_6,
      email: 'user-6@example.com',
      message: 'Password changed',
    });

    expect(pushAdapter.sent.some((m) => m.token === 'user-6-device')).toBe(
      true,
    );
  });
});
