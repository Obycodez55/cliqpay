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
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { WalletModule } from '../../../src/modules/wallet/wallet.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { LedgerEntry } from '../../../src/modules/ledger/entities/ledger-entry.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { Money } from '../../../src/shared/primitives/money';

export interface LedgerTestContext {
  database: TestDatabase;
  app: INestApplication<App>;
  usersService: UsersService;
  ledgerService: LedgerService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  ledgerEntryRepo: Repository<LedgerEntry>;
}

// A lighter context than payments-test-context.ts — the transactions-history
// endpoint (issue #16) lives entirely on the wallet module's controller and never
// touches a provider, Redis, or notifications, so this only wires up
// UsersModule + LedgerModule + WalletModule against a real Postgres (Testcontainers).
export async function createLedgerTestContext(): Promise<LedgerTestContext> {
  const database = await createTestDatabase();

  const config: AppConfig = buildTestAppConfig({
    database: { url: database.url },
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
      WalletModule,
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
    app,
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    ledgerEntryRepo: dataSource.getRepository(LedgerEntry),
  };
}

export async function destroyLedgerTestContext(
  ctx: Partial<LedgerTestContext>,
): Promise<void> {
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
}

// Same pattern as payments-test-context.ts's seedUserWithWallet — directly
// creates a User + user_wallet Account, bypassing the full register() flow
// (auth module isn't loaded in this context).
export async function seedUserWithWallet(
  ctx: LedgerTestContext,
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

// Drives a completed funding transaction through the real
// createPendingFundingTransaction/postFunding path (not hand-inserted
// ledger_entries rows) so seeded history stays honest about what actually
// produces an entry — see LedgerService.postFunding.
export async function seedCompletedFunding(
  ctx: LedgerTestContext,
  args: { walletId: string; reference: string; netAmountMinor: bigint },
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
      `seedCompletedFunding: postFunding returned null for reference "${args.reference}"`,
    );
  }
}
