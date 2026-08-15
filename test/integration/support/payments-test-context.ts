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
import { json, Request, urlencoded } from 'express';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import { CreateUsersAndAccounts1784628665852 } from '../../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { AddUsernameChangedAtToUsers1784707276061 } from '../../../src/database/migrations/1784707276061-AddUsernameChangedAtToUsers';
import { AddPendingEmailToUsers1784707276064 } from '../../../src/database/migrations/1784707276064-AddPendingEmailToUsers';
import { AddPendingPhoneToUsers1784707276065 } from '../../../src/database/migrations/1784707276065-AddPendingPhoneToUsers';
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { AddFundingQueryIndexes1785488695081 } from '../../../src/database/migrations/1785488695081-AddFundingQueryIndexes';
import { EnforceLedgerEntriesAppendOnly1785491930164 } from '../../../src/database/migrations/1785491930164-EnforceLedgerEntriesAppendOnly';
import { CreateCredentials1784707276062 } from '../../../src/database/migrations/1784707276062-CreateCredentials';
import { CreateNotifications1786812506579 } from '../../../src/database/migrations/1786812506579-CreateNotifications';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { PaymentsModule } from '../../../src/modules/payments/payments.module';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { NotificationEventsProcessor } from '../../../src/modules/notifications/internal/notification-events.processor';
import { OtpNotificationProcessor } from '../../../src/modules/notifications/internal/otp.processor';
import { ChannelDispatchProcessor } from '../../../src/modules/notifications/internal/channel-dispatch.processor';
import { FundingPollProcessor } from '../../../src/modules/payments/internal/funding-poll.processor';
import { ReconciliationProcessor } from '../../../src/modules/payments/internal/reconciliation.processor';

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

export interface PaymentsTestContext {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  usersService: UsersService;
  ledgerService: LedgerService;
  paymentsService: PaymentsService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
  fakeAdapter: FakeAdapter;
  emailAdapter: FakeEmailAdapter;
}

// Real Postgres and a real Redis via Testcontainers — PaymentsModule now
// imports EventBusModule (issue #13's funding_completed publish after a
// webhook completes funding), so Redis and NotificationsModule are wired in
// the same way auth-test-context.ts does it, to assert delivery rather than
// just that EventBusService was called. Users are seeded directly via
// UsersService + LedgerService rather than through the real register()
// flow, since exercising registration itself isn't what these tests are
// about.
export async function createPaymentsTestContext(): Promise<PaymentsTestContext> {
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
  await new ConvertUsersAndAccountsTimestamps1784707276057().up(queryRunner);
  await new AddUsernameChangedAtToUsers1784707276061().up(queryRunner);
  await new CreateCredentials1784707276062().up(queryRunner);
  await new AddPendingEmailToUsers1784707276064().up(queryRunner);
  await new AddPendingPhoneToUsers1784707276065().up(queryRunner);
  await new CreateTransactionsAndLedgerEntries1784707276066().up(queryRunner);
  await new AddFundingQueryIndexes1785488695081().up(queryRunner);
  await new EnforceLedgerEntriesAppendOnly1785491930164().up(queryRunner);
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
    jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
    encryption: { key: 'a'.repeat(64) },
    transactionPin: { pepper: 'b'.repeat(64) },
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
      UsersModule,
      LedgerModule,
      PaymentsModule,
      NotificationsModule,
    ],
  }).compile();

  // bodyParser: false + a manual json() with a `verify` callback — matches
  // main.ts exactly, so the webhook route's `req.rawBody` is populated here
  // the same way it is in the real app. Nest's default built-in body parser
  // has no `verify` hook, so leaving it enabled would silently leave
  // `req.rawBody` undefined.
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    bodyParser: false,
  });
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ limit: '1mb', extended: true }));
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
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    paymentsService: moduleRef.get(PaymentsService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    fakeAdapter: moduleRef.get(PAYMENT_PROVIDER_ADAPTER),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
  };
}

// This context bootstraps PaymentsModule + NotificationsModule together,
// which between them register 5 BullMQ queues/workers -- the only test
// context in this suite that does. Plain app.close() relies on
// @nestjs/bullmq's own shutdown hook, which closes every worker
// *gracefully* (BullExplorer.onApplicationShutdown -> worker.close()).
// Under Jest's default (non-`--runInBand`) child-process execution, one of
// those graceful closes reliably never resolves once there are 5 of them in
// play, hanging app.close() -- and with it the whole test process --
// indefinitely. It doesn't reproduce under --runInBand or in the real app,
// only in this specific multi-process-worker + 5-queue combination.
// Force-closing every WorkerHost's underlying worker first (force: true
// skips waiting on in-flight jobs, which is fine here -- nothing is
// mid-delivery between test cases) sidesteps it entirely; the subsequent
// app.close() then has nothing left to gracefully wait on.
async function forceCloseWorkers(app: INestApplication<App>): Promise<void> {
  const hosts = [
    NotificationEventsProcessor,
    OtpNotificationProcessor,
    ChannelDispatchProcessor,
    FundingPollProcessor,
    ReconciliationProcessor,
  ];
  await Promise.all(
    hosts.map(async (hostClass) => {
      const host = app.get(hostClass, { strict: false });
      await host?.worker?.close(true);
    }),
  );
}

export async function destroyPaymentsTestContext(
  ctx: Partial<PaymentsTestContext>,
): Promise<void> {
  if (ctx.app) {
    await forceCloseWorkers(ctx.app);
  }
  await ctx.app?.close();
  await ctx.postgres?.stop();
  await ctx.redis?.stop();
}

// Directly creates a User + user_wallet Account, bypassing the full
// register() flow (auth module isn't loaded in this context) — matches how
// LedgerService.createUserWallet/UsersService.createUser are meant to be
// composed atomically (see auth.service.ts's own registration flow).
export async function seedUserWithWallet(
  ctx: PaymentsTestContext,
  overrides: { email: string; phone: string; username: string },
): Promise<{ userId: string; walletId: string }> {
  return ctx.dataSource.transaction(async (manager) => {
    const user = await ctx.usersService.createUser(manager, {
      email: overrides.email,
      phone: overrides.phone,
      username: overrides.username,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const wallet = await ctx.ledgerService.createUserWallet(
      manager,
      user.id,
      'NGN',
    );
    return { userId: user.id, walletId: wallet.id };
  });
}
