import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { App } from 'supertest/types';
import { json, Request, urlencoded } from 'express';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  buildTestAppConfig,
  buildTestConfigModule,
  buildTestJwtModule,
} from './test-app-config';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import {
  KycTier,
  UsersService,
} from '../../../src/modules/users/users.service';
import { KycService } from '../../../src/modules/kyc/kyc.service';
import { PaymentsModule } from '../../../src/modules/payments/payments.module';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';

import { closeBullmqWorkers } from './bullmq-teardown';
export interface PaymentsTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  usersService: UsersService;
  ledgerService: LedgerService;
  paymentsService: PaymentsService;
  kycService: KycService;
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
    database,
    redis,
    app,
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    paymentsService: moduleRef.get(PaymentsService),
    kycService: moduleRef.get(KycService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    fakeAdapter: moduleRef.get(PAYMENT_PROVIDER_ADAPTER),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
  };
}

export async function destroyPaymentsTestContext(
  ctx: Partial<PaymentsTestContext>,
): Promise<void> {
  if (ctx.app) {
    await closeBullmqWorkers(ctx.app);
  }
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
  await ctx.redis?.stop();
}

// Directly creates a User + user_wallet Account, bypassing the full
// register() flow (auth module isn't loaded in this context) — matches how
// LedgerService.createUserWallet/UsersService.createUser are meant to be
// composed atomically (see auth.service.ts's own registration flow).
export async function seedUserWithWallet(
  ctx: PaymentsTestContext,
  overrides: {
    email: string;
    phone: string;
    username: string;
    kycTier?: KycTier;
  },
): Promise<{ userId: string; walletId: string }> {
  return ctx.dataSource.transaction(async (manager) => {
    const user = await ctx.usersService.createUser(manager, {
      email: overrides.email,
      phone: overrides.phone,
      username: overrides.username,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await ctx.usersService.setKycTier(
      manager,
      user.id,
      overrides.kycTier ?? 'tier3',
    );
    const wallet = await ctx.ledgerService.createUserWallet(
      manager,
      user.id,
      'NGN',
    );
    return { userId: user.id, walletId: wallet.id };
  });
}
