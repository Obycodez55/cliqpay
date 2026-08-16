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
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { AddFundingQueryIndexes1785488695081 } from '../../../src/database/migrations/1785488695081-AddFundingQueryIndexes';
import { EnforceLedgerEntriesAppendOnly1785491930164 } from '../../../src/database/migrations/1785491930164-EnforceLedgerEntriesAppendOnly';
import { AddTransactionPinLockoutToCredentials1785491931164 } from '../../../src/database/migrations/1785491931164-AddTransactionPinLockoutToCredentials';
import { CreateNotifications1786812506579 } from '../../../src/database/migrations/1786812506579-CreateNotifications';
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
import { UsersService } from '../../../src/modules/users/users.service';
import { TransfersModule } from '../../../src/modules/transfers/transfers.module';
import { TransfersService } from '../../../src/modules/transfers/transfers.service';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { NotificationService } from '../../../src/modules/notifications/notification.service';
import { Notification } from '../../../src/modules/notifications/entities/notification.entity';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { PUSH_SENDER } from '../../../src/modules/notifications/channels/push/push-sender.interface';
import { FakePushAdapter } from '../../../src/modules/notifications/channels/push/fake-push.adapter';
import { NotificationEventsProcessor } from '../../../src/modules/notifications/internal/notification-events.processor';
import { OtpNotificationProcessor } from '../../../src/modules/notifications/internal/otp.processor';
import { ChannelDispatchProcessor } from '../../../src/modules/notifications/internal/channel-dispatch.processor';
import { hashTransactionPin } from '../../../src/modules/auth/internal/pin.util';
import { Money } from '../../../src/shared/primitives/money';

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

export const TEST_PIN_PEPPER = 'b'.repeat(64);

export interface TransfersTestContext {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  usersService: UsersService;
  ledgerService: LedgerService;
  transfersService: TransfersService;
  notificationService: NotificationService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  credentialRepo: Repository<Credential>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
  notificationRepo: Repository<Notification>;
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
  await new CreateTransactionsAndLedgerEntries1784707276066().up(queryRunner);
  await new AddFundingQueryIndexes1785488695081().up(queryRunner);
  await new EnforceLedgerEntriesAppendOnly1785491930164().up(queryRunner);
  await new AddTransactionPinLockoutToCredentials1785491931164().up(
    queryRunner,
  );
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
    transfers: {
      platformFee,
      minAmount: 10_000,
      maxAmount: 100_000_000,
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
    postgres,
    redis,
    app,
    authService: moduleRef.get(AuthService),
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    transfersService: moduleRef.get(TransfersService),
    notificationService: moduleRef.get(NotificationService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    credentialRepo: dataSource.getRepository(Credential),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    notificationRepo: dataSource.getRepository(Notification),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
    pushAdapter: moduleRef.get(PUSH_SENDER),
    config,
  };
}

// Same BullMQ multi-worker shutdown hazard as payments-test-context.ts's
// forceCloseWorkers — see that file's comment for the full explanation.
async function forceCloseWorkers(app: INestApplication<App>): Promise<void> {
  const hosts = [
    NotificationEventsProcessor,
    OtpNotificationProcessor,
    ChannelDispatchProcessor,
  ];
  await Promise.all(
    hosts.map(async (hostClass) => {
      const host = app.get(hostClass, { strict: false });
      await host?.worker?.close(true);
    }),
  );
}

export async function destroyTransfersTestContext(
  ctx: Partial<TransfersTestContext>,
): Promise<void> {
  if (ctx.app) {
    await forceCloseWorkers(ctx.app);
  }
  await ctx.app?.close();
  await ctx.postgres?.stop();
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
