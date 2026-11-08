import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  buildTestAppConfig,
  buildTestConfigModule,
  buildTestJwtModule,
  buildTestPipelineModules,
} from './test-app-config';
import { EventBusModule } from '../../../src/shared/events/event-bus.module';
import { EventBusService } from '../../../src/shared/events/event-bus.service';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { NotificationService } from '../../../src/modules/notifications/notification.service';
import { Notification } from '../../../src/modules/notifications/entities/notification.entity';
import { PushToken } from '../../../src/modules/notifications/entities/push-token.entity';
import { PUSH_SENDER } from '../../../src/modules/notifications/channels/push/push-sender.interface';
import { FakePushAdapter } from '../../../src/modules/notifications/channels/push/fake-push.adapter';
import { closeBullmqWorkers } from './bullmq-teardown';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';

export interface NotificationsTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  eventBus: EventBusService;
  notificationService: NotificationService;
  notificationRepo: Repository<Notification>;
  pushTokenRepo: Repository<PushToken>;
  pushAdapter: FakePushAdapter;
  tokenFor: (userId: string) => string;
}

export async function createNotificationsTestContext(): Promise<NotificationsTestContext> {
  const database = await createTestDatabase();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const config: AppConfig = buildTestAppConfig({
    database: { url: database.url },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      buildTestConfigModule(config),
      buildTestJwtModule(),
      ...buildTestPipelineModules(),
      TypeOrmModule.forRootAsync({
        inject: [APP_CONFIG],
        useFactory: (cfg: AppConfig) => buildDataSourceOptions(cfg),
      }),
      EventBusModule,
      NotificationsModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  const jwtService = moduleRef.get(JwtService);

  return {
    database,
    redis,
    app,
    eventBus: moduleRef.get(EventBusService),
    notificationService: moduleRef.get(NotificationService),
    notificationRepo: moduleRef.get(getRepositoryToken(Notification)),
    pushTokenRepo: moduleRef.get(getRepositoryToken(PushToken)),
    pushAdapter: moduleRef.get(PUSH_SENDER),
    tokenFor: (userId) => jwtService.sign({ sub: userId, sid: 'session-1' }),
  };
}

export async function destroyNotificationsTestContext(
  ctx: Partial<NotificationsTestContext>,
): Promise<void> {
  if (ctx.app) {
    await closeBullmqWorkers(ctx.app);
  }
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
  await ctx.redis?.stop();
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
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
