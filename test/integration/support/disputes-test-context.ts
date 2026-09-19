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
} from './test-app-config';
import { CreateUsersAndAccounts1784628665852 } from '../../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { AddUsernameChangedAtToUsers1784707276061 } from '../../../src/database/migrations/1784707276061-AddUsernameChangedAtToUsers';
import { CreateCredentials1784707276062 } from '../../../src/database/migrations/1784707276062-CreateCredentials';
import { AddPendingEmailToUsers1784707276064 } from '../../../src/database/migrations/1784707276064-AddPendingEmailToUsers';
import { AddPendingPhoneToUsers1784707276065 } from '../../../src/database/migrations/1784707276065-AddPendingPhoneToUsers';
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { AddFundingQueryIndexes1785488695081 } from '../../../src/database/migrations/1785488695081-AddFundingQueryIndexes';
import { EnforceLedgerEntriesAppendOnly1785491930164 } from '../../../src/database/migrations/1785491930164-EnforceLedgerEntriesAppendOnly';
import { CreateNotifications1786812506579 } from '../../../src/database/migrations/1786812506579-CreateNotifications';
import { CreateDisputes1787500000000 } from '../../../src/database/migrations/1787500000000-CreateDisputes';
import { AddIsFrozenToUsers1787500000001 } from '../../../src/database/migrations/1787500000001-AddIsFrozenToUsers';
import { AddChargebackReversalTransactionType1787500000002 } from '../../../src/database/migrations/1787500000002-AddChargebackReversalTransactionType';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { DisputesModule } from '../../../src/modules/disputes/disputes.module';
import { DisputesService } from '../../../src/modules/disputes/disputes.service';
import { Dispute } from '../../../src/modules/disputes/entities/dispute.entity';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module';
import { Notification } from '../../../src/modules/notifications/entities/notification.entity';
import { EMAIL_SENDER } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../../src/modules/notifications/channels/email/fake-email.adapter';
import { NotificationEventsProcessor } from '../../../src/modules/notifications/internal/notification-events.processor';
import { OtpNotificationProcessor } from '../../../src/modules/notifications/internal/otp.processor';
import { ChannelDispatchProcessor } from '../../../src/modules/notifications/internal/channel-dispatch.processor';
import { Money } from '../../../src/shared/primitives/money';

export interface DisputesTestContext {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  usersService: UsersService;
  ledgerService: LedgerService;
  disputesService: DisputesService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
  disputeRepo: Repository<Dispute>;
  notificationRepo: Repository<Notification>;
  emailAdapter: FakeEmailAdapter;
  config: AppConfig;
}

// No AuthModule — this module's one endpoint is admin-triggered
// (InternalSecretGuard, not JwtAuthGuard/PIN), so seeding a user only needs
// UsersService + LedgerService, same "exercising the other flow isn't what
// these tests are about" reasoning as the other test-context files.
// buildTestJwtModule() is still required, though — UsersModule's own
// controllers (profile/recipient) guard themselves with JwtAuthGuard, which
// needs JwtService injectable regardless of whether this suite's own
// requests ever hit those routes. Also still needs
// CreateCredentials1784707276062 to run even though nothing here touches
// `credentials` — it's what drops the now-auth-owned columns (password_hash
// etc.) off `users`, which `UsersService.createUser` never sets.
export async function createDisputesTestContext(): Promise<DisputesTestContext> {
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
  await new CreateDisputes1787500000000().up(queryRunner);
  await new AddIsFrozenToUsers1787500000001().up(queryRunner);
  await new AddChargebackReversalTransactionType1787500000002().up(queryRunner);
  await queryRunner.release();
  await setupDataSource.destroy();

  const config: AppConfig = buildTestAppConfig({
    database: { url: postgres.getConnectionUri() },
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
      DisputesModule,
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
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    disputesService: moduleRef.get(DisputesService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
    disputeRepo: dataSource.getRepository(Dispute),
    notificationRepo: dataSource.getRepository(Notification),
    emailAdapter: moduleRef.get(EMAIL_SENDER),
    config,
  };
}

// Same BullMQ multi-worker shutdown hazard as the other test-context files
// — see payments-test-context.ts's forceCloseWorkers for the full
// explanation.
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

export async function destroyDisputesTestContext(
  ctx: Partial<DisputesTestContext>,
): Promise<void> {
  if (ctx.app) {
    await forceCloseWorkers(ctx.app);
  }
  await ctx.app?.close();
  await ctx.postgres?.stop();
  await ctx.redis?.stop();
}

// Directly creates a User + user_wallet Account, bypassing registration —
// same reasoning as transfers-test-context.ts's seedTransferUser. No
// Credential row at all: this module's endpoint is admin-triggered, so no
// test here ever needs a PIN.
export async function seedDisputesUser(
  ctx: DisputesTestContext,
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
    await manager
      .getRepository(User)
      .update({ id: user.id }, { emailVerifiedAt: new Date() });
    const wallet = await ctx.ledgerService.createUserWallet(
      manager,
      user.id,
      'NGN',
    );
    return { userId: user.id, walletId: wallet.id };
  });
}

// Real funding posting (not a raw balance UPDATE) — same reasoning as every
// other test-context file's fundWallet, so the resulting transaction row is
// a real, chargebackable `completed` funding transaction.
export async function fundWallet(
  ctx: DisputesTestContext,
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
