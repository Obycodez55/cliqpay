import { GenericContainer, StartedTestContainer } from 'testcontainers';
import {
  DynamicModule,
  INestApplication,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  buildTestAppConfig,
  buildTestConfigModule,
  buildTestJwtModule,
  buildTestPipelineModules,
} from './test-app-config';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import { AuthModule } from '../../../src/modules/auth/auth.module';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { Credential } from '../../../src/modules/auth/entities/credential.entity';
import { MfaChallenge } from '../../../src/modules/auth/entities/mfa-challenge.entity';
import { MfaMethod } from '../../../src/modules/auth/entities/mfa-method.entity';
import { Session } from '../../../src/modules/auth/entities/session.entity';
import { TrustedDevice } from '../../../src/modules/auth/entities/trusted-device.entity';
import { VerificationCode } from '../../../src/modules/auth/entities/verification-code.entity';
import { MfaService } from '../../../src/modules/auth/mfa.service';
import { SessionService } from '../../../src/modules/auth/session.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { SMS_SENDER } from '../../../src/modules/notifications/channels/sms/sms-sender.interface';
import { FakeSmsAdapter } from '../../../src/modules/notifications/channels/sms/fake-sms.adapter';
import { closeBullmqWorkers } from './bullmq-teardown';

export interface AuthTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  mfaService: MfaService;
  sessionService: SessionService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  credentialRepo: Repository<Credential>;
  accountRepo: Repository<Account>;
  sessionRepo: Repository<Session>;
  mfaMethodRepo: Repository<MfaMethod>;
  mfaChallengeRepo: Repository<MfaChallenge>;
  trustedDeviceRepo: Repository<TrustedDevice>;
  verificationCodeRepo: Repository<VerificationCode>;
  emailAdapter: FakeEmailAdapter;
  smsAdapter: FakeSmsAdapter;
}

// Real Postgres and a real Redis via Testcontainers — proves
// register()/login()/refresh()/logout() and the MFA/trusted-device flow
// against the actual migrations' schema and constraints, not mocks. Redis is
// needed because AuthModule imports EventBusModule — both the refresh()
// reuse-detection alert and the MFA challenge email dispatch go through it;
// NotificationsModule is wired in alongside it so delivery can be asserted,
// not just that EventBusService was called.
export async function createAuthTestContext(
  extraImports: (DynamicModule | Type<unknown>)[] = [],
): Promise<AuthTestContext> {
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
      UsersModule,
      LedgerModule,
      AuthModule,
      NotificationsModule,
      ...extraImports,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  // Matches main.ts's global pipe — without it, DTO validation (e.g.
  // CompletePasswordResetDto's required revokeOtherSessions) never runs.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  const dataSource = moduleRef.get(DataSource);

  return {
    database,
    redis,
    app,
    authService: moduleRef.get(AuthService),
    mfaService: moduleRef.get(MfaService),
    sessionService: moduleRef.get(SessionService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    credentialRepo: dataSource.getRepository(Credential),
    accountRepo: dataSource.getRepository(Account),
    sessionRepo: dataSource.getRepository(Session),
    mfaMethodRepo: dataSource.getRepository(MfaMethod),
    mfaChallengeRepo: dataSource.getRepository(MfaChallenge),
    trustedDeviceRepo: dataSource.getRepository(TrustedDevice),
    verificationCodeRepo: dataSource.getRepository(VerificationCode),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
    smsAdapter: moduleRef.get(SMS_SENDER),
  };
}

export async function destroyAuthTestContext(
  ctx: Partial<AuthTestContext>,
): Promise<void> {
  if (ctx.app) {
    await closeBullmqWorkers(ctx.app);
  }
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
  await ctx.redis?.stop();
}
