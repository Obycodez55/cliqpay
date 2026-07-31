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
import { TypeOrmModule } from '@nestjs/typeorm';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import { CreateUsersAndAccounts1784628665852 } from '../../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { CreateSessions1784642459395 } from '../../../src/database/migrations/1784642459395-CreateSessions';
import { CreatePushTokens1784616220824 } from '../../../src/database/migrations/1784616220824-CreatePushTokens';
import { CreateMfaAndTrustedDevices1784652789887 } from '../../../src/database/migrations/1784652789887-CreateMfaAndTrustedDevices';
import { CreateVerificationCodes1784672011426 } from '../../../src/database/migrations/1784672011426-CreateVerificationCodes';
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { ConvertSessionsTimestamps1784707276058 } from '../../../src/database/migrations/1784707276058-ConvertSessionsTimestamps';
import { ConvertPushTokensTimestamps1784707276059 } from '../../../src/database/migrations/1784707276059-ConvertPushTokensTimestamps';
import { ConvertMfaAndTrustedDevicesTimestamps1784707276060 } from '../../../src/database/migrations/1784707276060-ConvertMfaAndTrustedDevicesTimestamps';
import { AddUsernameChangedAtToUsers1784707276061 } from '../../../src/database/migrations/1784707276061-AddUsernameChangedAtToUsers';
import { CreateCredentials1784707276062 } from '../../../src/database/migrations/1784707276062-CreateCredentials';
import { DropUserForeignKeys1784707276063 } from '../../../src/database/migrations/1784707276063-DropUserForeignKeys';
import { AddPendingEmailToUsers1784707276064 } from '../../../src/database/migrations/1784707276064-AddPendingEmailToUsers';
import { AddPendingPhoneToUsers1784707276065 } from '../../../src/database/migrations/1784707276065-AddPendingPhoneToUsers';
import { AuthModule } from '../../../src/modules/auth/auth.module';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { Credential } from '../../../src/modules/auth/entities/credential.entity';
import { MfaChallenge } from '../../../src/modules/auth/entities/mfa-challenge.entity';
import { MfaMethod } from '../../../src/modules/auth/entities/mfa-method.entity';
import { Session } from '../../../src/modules/auth/entities/session.entity';
import { TrustedDevice } from '../../../src/modules/auth/entities/trusted-device.entity';
import { VerificationCode } from '../../../src/modules/auth/entities/verification-code.entity';
import { MfaService } from '../../../src/modules/auth/mfa.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { SMS_SENDER } from '../../../src/modules/notifications/channels/sms/sms-sender.interface';
import { FakeSmsAdapter } from '../../../src/modules/notifications/channels/sms/fake-sms.adapter';

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

export interface AuthTestContext {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  mfaService: MfaService;
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
export async function createAuthTestContext(): Promise<AuthTestContext> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const setupDataSource = new DataSource({
    type: 'postgres',
    url: postgres.getConnectionUri(),
    synchronize: false,
  });
  await setupDataSource.initialize();
  const queryRunner = setupDataSource.createQueryRunner();
  await new CreateUsersAndAccounts1784628665852().up(queryRunner);
  await new CreateSessions1784642459395().up(queryRunner);
  await new CreatePushTokens1784616220824().up(queryRunner);
  await new CreateMfaAndTrustedDevices1784652789887().up(queryRunner);
  await new CreateVerificationCodes1784672011426().up(queryRunner);
  await new ConvertUsersAndAccountsTimestamps1784707276057().up(queryRunner);
  await new ConvertSessionsTimestamps1784707276058().up(queryRunner);
  await new ConvertPushTokensTimestamps1784707276059().up(queryRunner);
  await new ConvertMfaAndTrustedDevicesTimestamps1784707276060().up(
    queryRunner,
  );
  await new AddUsernameChangedAtToUsers1784707276061().up(queryRunner);
  await new CreateCredentials1784707276062().up(queryRunner);
  await new DropUserForeignKeys1784707276063().up(queryRunner);
  await new AddPendingEmailToUsers1784707276064().up(queryRunner);
  await new AddPendingPhoneToUsers1784707276065().up(queryRunner);
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
    jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
    encryption: {
      key: 'a'.repeat(64),
    },
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
    payments: {
      provider: 'fake',
      kora: { secretKey: undefined },
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
      UsersModule,
      LedgerModule,
      AuthModule,
      NotificationsModule,
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
    postgres,
    redis,
    app,
    authService: moduleRef.get(AuthService),
    mfaService: moduleRef.get(MfaService),
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
  await ctx.app?.close();
  await ctx.postgres?.stop();
  await ctx.redis?.stop();
}
