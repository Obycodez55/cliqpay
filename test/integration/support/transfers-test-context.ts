import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
  TEST_PIN_PEPPER,
} from './test-app-config';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import { AuthModule } from '../../../src/modules/auth/auth.module';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { Credential } from '../../../src/modules/auth/entities/credential.entity';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import {
  KycTier,
  UsersService,
} from '../../../src/modules/users/users.service';
import { TransfersModule } from '../../../src/modules/transfers/transfers.module';
import { TransfersService } from '../../../src/modules/transfers/transfers.service';
import { MoneyRequestsService } from '../../../src/modules/transfers/money-requests.service';
import { MoneyRequest } from '../../../src/modules/transfers/entities/money-request.entity';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { NotificationService } from '../../../src/modules/notifications/notification.service';
import { Notification } from '../../../src/modules/notifications/entities/notification.entity';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { PUSH_SENDER } from '../../../src/modules/notifications/channels/push/push-sender.interface';
import { FakePushAdapter } from '../../../src/modules/notifications/channels/push/fake-push.adapter';
import { hashTransactionPin } from '../../../src/modules/auth/internal/pin.util';
import { Money } from '../../../src/shared/primitives/money';

import { closeBullmqWorkers } from './bullmq-teardown';
export interface TransfersTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  usersService: UsersService;
  ledgerService: LedgerService;
  transfersService: TransfersService;
  moneyRequestsService: MoneyRequestsService;
  notificationService: NotificationService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  credentialRepo: Repository<Credential>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
  notificationRepo: Repository<Notification>;
  moneyRequestRepo: Repository<MoneyRequest>;
  emailAdapter: FakeEmailAdapter;
  pushAdapter: FakePushAdapter;
  config: AppConfig;
}

// Combines auth-test-context's migration/module set (needed for PIN
// verification and lockout) with payments-test-context's ledger migrations
// (needed for postTransfer to have somewhere to write) — transfers is the
// first flow that genuinely needs both at once.
export async function createTransfersTestContext(
  platformFee = 0,
): Promise<TransfersTestContext> {
  const database = await createTestDatabase();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const config: AppConfig = buildTestAppConfig({
    database: { url: database.url },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
    transfers: {
      platformFee,
      minAmount: 10_000,
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
      AuthModule,
      TransfersModule,
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

  const dataSource = moduleRef.get(DataSource);

  return {
    database,
    redis,
    app,
    authService: moduleRef.get(AuthService),
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    transfersService: moduleRef.get(TransfersService),
    moneyRequestsService: moduleRef.get(MoneyRequestsService),
    notificationService: moduleRef.get(NotificationService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    credentialRepo: dataSource.getRepository(Credential),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    notificationRepo: dataSource.getRepository(Notification),
    moneyRequestRepo: dataSource.getRepository(MoneyRequest),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
    pushAdapter: moduleRef.get(PUSH_SENDER),
    config,
  };
}

export async function destroyTransfersTestContext(
  ctx: Partial<TransfersTestContext>,
): Promise<void> {
  if (ctx.app) {
    await closeBullmqWorkers(ctx.app);
  }
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
  await ctx.redis?.stop();
}

// Directly creates a User + user_wallet Account + Credential with a known
// PIN, bypassing registration and the step-up MFA set-PIN flow — same
// reasoning as payments-test-context.ts's seedUserWithWallet: exercising
// registration/step-up isn't what these tests are about.
export async function seedTransferUser(
  ctx: TransfersTestContext,
  overrides: {
    email: string;
    phone: string;
    username: string;
    pin?: string;
    emailVerified?: boolean;
    kycTier?: KycTier;
  },
): Promise<{ userId: string; walletId: string }> {
  const pin = overrides.pin ?? '1234';
  return ctx.dataSource.transaction(async (manager) => {
    const user = await ctx.usersService.createUser(manager, {
      email: overrides.email,
      phone: overrides.phone,
      username: overrides.username,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    if (overrides.emailVerified !== false) {
      await manager
        .getRepository(User)
        .update({ id: user.id }, { emailVerifiedAt: new Date() });
    }
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
    const credentialRepo = manager.getRepository(Credential);
    const credential = credentialRepo.create({
      userId: user.id,
      passwordHash: 'unused-in-these-tests',
      transactionPinHash: await hashTransactionPin(pin, TEST_PIN_PEPPER),
    });
    await credentialRepo.save(credential);
    return { userId: user.id, walletId: wallet.id };
  });
}

// Real funding posting (not a raw balance UPDATE) so a seeded wallet's
// balance stays consistent with an actual ledger_entries trail — same
// reasoning as ledger-test-context.ts's seedCompletedFunding.
export async function fundWallet(
  ctx: TransfersTestContext,
  args: { reference: string; walletId: string; netAmountMinor: bigint },
): Promise<void> {
  await ctx.ledgerService.createPendingFundingTransaction({
    reference: args.reference,
    provider: 'kora',
    providerReference: args.reference,
    amount: Money.of(args.netAmountMinor, 'NGN'),
    recipientWalletId: args.walletId,
    metadata: { checkoutUrl: null, grossAmount: null },
  });
  const result = await ctx.ledgerService.postFunding({
    reference: args.reference,
    netAmount: Money.of(args.netAmountMinor, 'NGN'),
    providerFee: Money.zero('NGN'),
    providerStatus: 'success',
  });
  if (!result) {
    throw new Error(
      `fundWallet: postFunding returned null for reference "${args.reference}"`,
    );
  }
}
