import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
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
import { AddTransactionPinLockoutToCredentials1785491931164 } from '../../../src/database/migrations/1785491931164-AddTransactionPinLockoutToCredentials';
import { CreateNotifications1786812506579 } from '../../../src/database/migrations/1786812506579-CreateNotifications';
import { CreateBankAccounts1787200000000 } from '../../../src/database/migrations/1787200000000-CreateBankAccounts';
import { AddWithdrawalReversalTransactionType1787300000000 } from '../../../src/database/migrations/1787300000000-AddWithdrawalReversalTransactionType';
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { AddFundingQueryIndexes1785488695081 } from '../../../src/database/migrations/1785488695081-AddFundingQueryIndexes';
import { EnforceLedgerEntriesAppendOnly1785491930164 } from '../../../src/database/migrations/1785491930164-EnforceLedgerEntriesAppendOnly';
import { AuthModule } from '../../../src/modules/auth/auth.module';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { MfaService } from '../../../src/modules/auth/mfa.service';
import { SessionService } from '../../../src/modules/auth/session.service';
import { Credential } from '../../../src/modules/auth/entities/credential.entity';
import { Session } from '../../../src/modules/auth/entities/session.entity';
import { MfaMethod } from '../../../src/modules/auth/entities/mfa-method.entity';
import { MfaChallenge } from '../../../src/modules/auth/entities/mfa-challenge.entity';
import { TrustedDevice } from '../../../src/modules/auth/entities/trusted-device.entity';
import { VerificationCode } from '../../../src/modules/auth/entities/verification-code.entity';
import { hashTransactionPin } from '../../../src/modules/auth/internal/pin.util';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { PaymentsModule } from '../../../src/modules/payments/payments.module';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';
import { WithdrawalsModule } from '../../../src/modules/withdrawals/withdrawals.module';
import { WithdrawalsService } from '../../../src/modules/withdrawals/withdrawals.service';
import { BankAccount } from '../../../src/modules/withdrawals/entities/bank-account.entity';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { SMS_SENDER } from '../../../src/modules/notifications/channels/sms/sms-sender.interface';
import { FakeSmsAdapter } from '../../../src/modules/notifications/channels/sms/fake-sms.adapter';
import { NotificationEventsProcessor } from '../../../src/modules/notifications/internal/notification-events.processor';
import { OtpNotificationProcessor } from '../../../src/modules/notifications/internal/otp.processor';
import { ChannelDispatchProcessor } from '../../../src/modules/notifications/internal/channel-dispatch.processor';
import { FundingPollProcessor } from '../../../src/modules/payments/internal/funding-poll.processor';
import { ReconciliationProcessor } from '../../../src/modules/payments/internal/reconciliation.processor';
import { Money } from '../../../src/shared/primitives/money';

// A superset of AuthTestContext's own fields (plus payments/withdrawals'
// own) so this context can be passed straight into
// auth-test-helpers.ts's createAuthTestHelpers — register()/login() aren't
// this module's own concern to re-implement.
export interface WithdrawalsTestContext {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  mfaService: MfaService;
  sessionService: SessionService;
  usersService: UsersService;
  ledgerService: LedgerService;
  withdrawalsService: WithdrawalsService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  credentialRepo: Repository<Credential>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
  sessionRepo: Repository<Session>;
  mfaMethodRepo: Repository<MfaMethod>;
  mfaChallengeRepo: Repository<MfaChallenge>;
  trustedDeviceRepo: Repository<TrustedDevice>;
  verificationCodeRepo: Repository<VerificationCode>;
  bankAccountRepo: Repository<BankAccount>;
  fakeAdapter: FakeAdapter;
  emailAdapter: FakeEmailAdapter;
  smsAdapter: FakeSmsAdapter;
  config: AppConfig;
}

// Combines auth-test-context's migration/module set (needed for
// register()/login()/step-up MFA) with PaymentsModule + WithdrawalsModule,
// plus the ledger's transactions/ledger_entries migrations — issue #28 is
// the first withdrawals work that actually posts to the ledger, so this
// context is the first one that needs all three at once (payments' provider
// resolution, auth's step-up/PIN, and ledger's posting).
export async function createWithdrawalsTestContext(
  withdrawalConfig: {
    minAmount?: number;
    maxAmount?: number;
    platformFee?: number;
    providerFee?: number;
  } = {},
): Promise<WithdrawalsTestContext> {
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
  await new CreateBankAccounts1787200000000().up(queryRunner);
  await new AddWithdrawalReversalTransactionType1787300000000().up(queryRunner);
  await queryRunner.release();
  await setupDataSource.destroy();

  const config: AppConfig = buildTestAppConfig({
    database: { url: postgres.getConnectionUri() },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
    withdrawals: {
      minAmount: withdrawalConfig.minAmount ?? 10_000,
      maxAmount: withdrawalConfig.maxAmount ?? 100_000_000,
      platformFee: withdrawalConfig.platformFee ?? 0,
      providerFee: withdrawalConfig.providerFee ?? 3_000,
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
      PaymentsModule,
      WithdrawalsModule,
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
    mfaService: moduleRef.get(MfaService),
    sessionService: moduleRef.get(SessionService),
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    withdrawalsService: moduleRef.get(WithdrawalsService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    credentialRepo: dataSource.getRepository(Credential),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    sessionRepo: dataSource.getRepository(Session),
    mfaMethodRepo: dataSource.getRepository(MfaMethod),
    mfaChallengeRepo: dataSource.getRepository(MfaChallenge),
    trustedDeviceRepo: dataSource.getRepository(TrustedDevice),
    verificationCodeRepo: dataSource.getRepository(VerificationCode),
    bankAccountRepo: dataSource.getRepository(BankAccount),
    fakeAdapter: moduleRef.get(PAYMENT_PROVIDER_ADAPTER),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
    smsAdapter: moduleRef.get(SMS_SENDER),
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

export async function destroyWithdrawalsTestContext(
  ctx: Partial<WithdrawalsTestContext>,
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
// reasoning as transfers-test-context.ts's seedTransferUser: exercising
// registration/step-up isn't what these tests are about.
export async function seedWithdrawalUser(
  ctx: WithdrawalsTestContext,
  overrides: {
    email: string;
    phone: string;
    username: string;
    pin?: string;
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
    await manager
      .getRepository(User)
      .update({ id: user.id }, { emailVerifiedAt: new Date() });
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

// Real funding posting (not a raw balance UPDATE) — same reasoning as
// transfers-test-context.ts's fundWallet.
export async function fundWallet(
  ctx: WithdrawalsTestContext,
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

// Inserts a BankAccount row directly, bypassing the step-up-gated
// saveBankAccount flow — same "exercising the other flow isn't what these
// tests are about" reasoning as seedWithdrawalUser above; issue #27's own
// spec already covers that flow.
export async function seedBankAccount(
  ctx: WithdrawalsTestContext,
  args: {
    userId: string;
    bankCode?: string;
    accountNumber?: string;
    bankName?: string;
    accountName?: string;
  },
): Promise<BankAccount> {
  const bankAccount = ctx.bankAccountRepo.create({
    userId: args.userId,
    provider: 'kora',
    bankCode: args.bankCode ?? '033',
    bankName: args.bankName ?? 'United Bank for Africa',
    accountNumber: args.accountNumber ?? '0000000000',
    accountName: args.accountName ?? 'Ada Lovelace',
  });
  return ctx.bankAccountRepo.save(bankAccount);
}
