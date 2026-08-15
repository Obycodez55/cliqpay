import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import {
  DynamicModule,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { App } from 'supertest/types';
import * as request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { EventBusModule } from '../../src/shared/events/event-bus.module';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { Notification } from '../../src/modules/notifications/entities/notification.entity';
import { NotificationItemDto } from '../../src/modules/notifications/dto/notification-item.dto';
import { UnreadCountResponseDto } from '../../src/modules/notifications/dto/unread-count-response.dto';
import { PaginatedResult } from '../../src/common/interfaces/paginated-result.interface';
import { CreatePushTokens1784616220824 } from '../../src/database/migrations/1784616220824-CreatePushTokens';
import { ConvertPushTokensTimestamps1784707276059 } from '../../src/database/migrations/1784707276059-ConvertPushTokensTimestamps';
import { CreateNotifications1786812506579 } from '../../src/database/migrations/1786812506579-CreateNotifications';

jest.setTimeout(120_000);

const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

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
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// The HTTP surface added by issue #20 (docs/adr/0013): list/unread-count/
// mark-read against a real Postgres and a real Redis, through the actual
// JwtAuthGuard and the actual BullMQ dispatch path (publish -> per-channel
// job -> in-app write), not a service called directly.
describe('Notifications API — list/unread-count/mark-read', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: INestApplication<App>;
  let eventBus: EventBusService;
  let notificationService: NotificationService;
  let notificationRepo: Repository<Notification>;
  let jwtService: JwtService;

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
    await new ConvertPushTokensTimestamps1784707276059().up(queryRunner);
    await new CreateNotifications1786812506579().up(queryRunner);
    await queryRunner.release();
    await setupDataSource.destroy();

    const config: AppConfig = {
      app: {
        env: 'test',
        port: 0,
        corsAllowedOrigins: [],
        emailVerificationUrl: 'http://localhost:3000/verify-email',
        passwordResetUrl: 'http://localhost:3000/reset-password',
      },
      database: { url: postgres.getConnectionUri() },
      redis: {
        url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
      sentry: { dsn: undefined },
      rateLimit: { ttlMs: 60_000, limit: 100 },
      jwt: { secret: JWT_SECRET },
      encryption: { key: '0'.repeat(64) },
      transactionPin: { pepper: '0'.repeat(64) },
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
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildTestConfigModule(config),
        TypeOrmModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (cfg: AppConfig) => buildDataSourceOptions(cfg),
        }),
        JwtModule.register({ secret: JWT_SECRET }),
        EventBusModule,
        NotificationsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    eventBus = moduleRef.get(EventBusService);
    notificationService = moduleRef.get(NotificationService);
    notificationRepo = moduleRef.get(getRepositoryToken(Notification));
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'session-1' });
  }

  it('persists a funding_completed event and returns it via GET /notifications', async () => {
    await eventBus.publish({
      name: 'funding_completed',
      payload: {
        userId: USER_A,
        email: 'a@example.com',
        amount: '5000.00',
        currency: 'NGN',
        reference: 'e2e-ref-1',
      },
      occurredAt: new Date(),
    });

    await waitFor(async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${tokenFor(USER_A)}`);
      const body = res.body as PaginatedResult<NotificationItemDto>;
      return body.items.some((item) => item.type === 'funding_completed');
    });

    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .expect(200);
    const body = res.body as PaginatedResult<NotificationItemDto>;
    expect(body.items[0]).toMatchObject({
      type: 'funding_completed',
      title: 'Wallet funded',
    });
  });

  it('does not create a second row for a genuine duplicate publish of the same event', async () => {
    const publishOnce = () =>
      eventBus.publish({
        name: 'funding_completed',
        payload: {
          userId: USER_A,
          email: 'a@example.com',
          amount: '1000.00',
          currency: 'NGN',
          reference: 'e2e-ref-dup',
        },
        occurredAt: new Date(),
      });

    await publishOnce();
    await waitFor(async () => {
      const count = await notificationRepo.count({
        where: { userId: USER_A, dedupeKey: 'e2e-ref-dup' },
      });
      return count === 1;
    });
    await publishOnce();
    // Give the second publish's channel-dispatch job time to run and hit
    // the unique constraint — a race here would show as count > 1.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const count = await notificationRepo.count({
      where: { userId: USER_A, dedupeKey: 'e2e-ref-dup' },
    });
    expect(count).toBe(1);
  });

  it('unread-count reflects reality and updates after marking read', async () => {
    // A dedicated user, not USER_A — other tests in this file publish
    // events for USER_A too, and their async channel-dispatch jobs can
    // still be landing rows under full-suite load. Sharing USER_A here
    // would make the exact "count == 0 after mark-read" assertion racy
    // against work this test doesn't own.
    const userId = 'cccccccc-3333-4333-8333-333333333333';
    const message = 'unread-count check';
    await eventBus.publish({
      name: 'security_alert',
      payload: {
        userId,
        email: 'c@example.com',
        message,
        occurredAt: new Date().toISOString(),
      },
      occurredAt: new Date(),
    });

    let unreadCount = 0;
    await waitFor(async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${tokenFor(userId)}`);
      unreadCount = (res.body as UnreadCountResponseDto).count;
      return unreadCount > 0;
    });
    expect(unreadCount).toBe(1);

    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ all: true })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .expect(200);
    expect((after.body as UnreadCountResponseDto).count).toBe(0);
  });

  it('marking read is idempotent — a second call does not move read_at', async () => {
    const notification = await notificationRepo.save(
      notificationRepo.create({
        userId: USER_A,
        type: 'security_alert',
        data: {},
        title: 'Idempotency check',
        body: 'x',
        dedupeKey: `idempotency-${Date.now()}`,
      }),
    );

    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ ids: [notification.id] })
      .expect(201);
    const firstReadAt = (
      await notificationRepo.findOneByOrFail({ id: notification.id })
    ).readAt;
    expect(firstReadAt).not.toBeNull();

    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .send({ ids: [notification.id] })
      .expect(201);
    const secondReadAt = (
      await notificationRepo.findOneByOrFail({ id: notification.id })
    ).readAt;
    expect(secondReadAt?.getTime()).toBe(firstReadAt?.getTime());
  });

  it('a cross-user id in mark-read is a silent no-op, not a 403', async () => {
    const notification = await notificationRepo.save(
      notificationRepo.create({
        userId: USER_A,
        type: 'security_alert',
        data: {},
        title: 'IDOR check',
        body: 'x',
        dedupeKey: `idor-${Date.now()}`,
      }),
    );

    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('Authorization', `Bearer ${tokenFor(USER_B)}`)
      .send({ ids: [notification.id] })
      .expect(201);

    const stillUnread = await notificationRepo.findOneByOrFail({
      id: notification.id,
    });
    expect(stillUnread.readAt).toBeNull();
  });

  it('a malformed cursor 400s without querying the database', async () => {
    await request(app.getHttpServer())
      .get('/notifications')
      .query({ cursor: 'not-a-valid-cursor' })
      .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
      .expect(400);
  });

  it('retention deletes rows older than the cutoff and keeps recent ones', async () => {
    const old = await notificationRepo.save(
      notificationRepo.create({
        userId: USER_A,
        type: 'security_alert',
        data: {},
        title: 'Old',
        body: 'x',
        dedupeKey: `retention-old-${Date.now()}`,
      }),
    );
    await notificationRepo.update(old.id, {
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
    const recent = await notificationRepo.save(
      notificationRepo.create({
        userId: USER_A,
        type: 'security_alert',
        data: {},
        title: 'Recent',
        body: 'x',
        dedupeKey: `retention-recent-${Date.now()}`,
      }),
    );

    await notificationService.deleteExpiredNotifications(
      new Date(Date.now() - 180 * 24 * 60 * 60 * 1000),
    );

    expect(await notificationRepo.findOneBy({ id: old.id })).toBeNull();
    expect(await notificationRepo.findOneBy({ id: recent.id })).not.toBeNull();
  });
});
