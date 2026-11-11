import { GenericContainer, StartedTestContainer } from 'testcontainers';
import {
  DynamicModule,
  INestApplication,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { json, Request, urlencoded } from 'express';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  buildTestAppConfig,
  buildTestConfigModule,
  buildTestJwtModule,
  buildTestPipelineModules,
  TEST_ENCRYPTION_KEY,
  TEST_IDENTIFIER_HASH_KEY,
  TEST_PIN_PEPPER,
} from './test-app-config';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import {
  encryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../../../src/shared/crypto/secrets.util';
import { AuthModule } from '../../../src/modules/auth/auth.module';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { MfaService } from '../../../src/modules/auth/mfa.service';
import { DeviceBindingService } from '../../../src/modules/auth/device-binding.service';
import { DeviceChallenge } from '../../../src/modules/auth/entities/device-challenge.entity';
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
import {
  KycTier,
  UsersService,
} from '../../../src/modules/users/users.service';
import { PaymentsModule } from '../../../src/modules/payments/payments.module';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';
import { KycService } from '../../../src/modules/kyc/kyc.service';
import { TransfersModule } from '../../../src/modules/transfers/transfers.module';
import { TransfersService } from '../../../src/modules/transfers/transfers.service';
import { WithdrawalsModule } from '../../../src/modules/withdrawals/withdrawals.module';
import { WithdrawalsService } from '../../../src/modules/withdrawals/withdrawals.service';
import { BankAccount } from '../../../src/modules/withdrawals/entities/bank-account.entity';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { SMS_SENDER } from '../../../src/modules/notifications/channels/sms/sms-sender.interface';
import { FakeSmsAdapter } from '../../../src/modules/notifications/channels/sms/fake-sms.adapter';
import { Money } from '../../../src/shared/primitives/money';
import { establishAccount } from './established-account';
import { closeBullmqWorkers } from './bullmq-teardown';

// A superset of AuthTestContext's own fields (plus payments/withdrawals'
// own) so this context can be passed straight into
// auth-test-helpers.ts's createAuthTestHelpers — register()/login() aren't
// this module's own concern to re-implement.
export interface WithdrawalsTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  authService: AuthService;
  mfaService: MfaService;
  sessionService: SessionService;
  deviceBindingService: DeviceBindingService;
  deviceChallengeRepo: Repository<DeviceChallenge>;
  usersService: UsersService;
  ledgerService: LedgerService;
  paymentsService: PaymentsService;
  withdrawalsService: WithdrawalsService;
  transfersService: TransfersService;
  kycService: KycService;
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
    platformFee?: number;
    providerFee?: number;
  } = {},
  extraImports: (DynamicModule | Type<unknown>)[] = [],
): Promise<WithdrawalsTestContext> {
  const database = await createTestDatabase();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const config: AppConfig = buildTestAppConfig({
    database: { url: database.url },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
    withdrawals: {
      minAmount: withdrawalConfig.minAmount ?? 10_000,
      platformFee: withdrawalConfig.platformFee ?? 0,
      providerFee: withdrawalConfig.providerFee ?? 3_000,
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
      PaymentsModule,
      WithdrawalsModule,
      TransfersModule,
      NotificationsModule,
      ...extraImports,
    ],
  }).compile();

  // bodyParser: false + a manual json() with a `verify` callback — matches
  // main.ts (and payments-test-context.ts) exactly, so the payout webhook
  // route's `req.rawBody` is populated here the same way it is in the real
  // app. Nest's default built-in body parser has no `verify` hook, so
  // leaving it enabled would silently leave `req.rawBody` undefined and
  // every webhook signature check would fail regardless of the signature's
  // actual correctness (issue #29 — this context didn't need raw webhook
  // bytes before the payout webhook existed).
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
    authService: moduleRef.get(AuthService),
    mfaService: moduleRef.get(MfaService),
    sessionService: moduleRef.get(SessionService),
    deviceBindingService: moduleRef.get(DeviceBindingService),
    deviceChallengeRepo: dataSource.getRepository(DeviceChallenge),
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    paymentsService: moduleRef.get(PaymentsService),
    withdrawalsService: moduleRef.get(WithdrawalsService),
    transfersService: moduleRef.get(TransfersService),
    kycService: moduleRef.get(KycService),
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

export async function destroyWithdrawalsTestContext(
  ctx: Partial<WithdrawalsTestContext>,
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
// reasoning as transfers-test-context.ts's seedTransferUser: exercising
// registration/step-up isn't what these tests are about.
export async function seedWithdrawalUser(
  ctx: WithdrawalsTestContext,
  overrides: {
    email: string;
    phone: string;
    username: string;
    pin?: string;
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
    await manager
      .getRepository(User)
      .update({ id: user.id }, { emailVerifiedAt: new Date() });
    await ctx.usersService.setKycTier(
      manager,
      user.id,
      overrides.kycTier ?? 'tier3',
    );
    await establishAccount(manager, user.id);
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
// Returns the plaintext `accountNumber` alongside the saved entity — the
// entity itself only ever holds the ciphertext (docs/architecture.md §7),
// and tests need the plaintext to assert against API responses without
// each one reaching for the encryption key itself.
export async function seedBankAccount(
  ctx: Pick<WithdrawalsTestContext, 'bankAccountRepo'>,
  args: {
    userId: string;
    bankCode?: string;
    accountNumber?: string;
    bankName?: string;
    accountName?: string;
    fullyEligibleAt?: Date;
  },
): Promise<BankAccount & { accountNumber: string }> {
  const accountNumber = args.accountNumber ?? '0000000000';
  const encryptionKey = encryptionKeyFromHex(TEST_ENCRYPTION_KEY);
  const bankAccount = ctx.bankAccountRepo.create({
    userId: args.userId,
    provider: 'kora',
    bankCode: args.bankCode ?? '033',
    bankName: args.bankName ?? 'United Bank for Africa',
    accountNumberCiphertext: encryptSecret(accountNumber, encryptionKey),
    accountNumberHash: hmacHex(
      accountNumber,
      encryptionKeyFromHex(TEST_IDENTIFIER_HASH_KEY),
    ),
    accountName: args.accountName ?? 'Ada Lovelace',
    fullyEligibleAt: args.fullyEligibleAt ?? new Date(),
  });
  const saved = await ctx.bankAccountRepo.save(bankAccount);
  return Object.assign(saved, { accountNumber });
}
