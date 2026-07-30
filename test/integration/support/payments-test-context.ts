import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
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
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { AddUsernameChangedAtToUsers1784707276061 } from '../../../src/database/migrations/1784707276061-AddUsernameChangedAtToUsers';
import { AddPendingEmailToUsers1784707276064 } from '../../../src/database/migrations/1784707276064-AddPendingEmailToUsers';
import { AddPendingPhoneToUsers1784707276065 } from '../../../src/database/migrations/1784707276065-AddPendingPhoneToUsers';
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { CreateCredentials1784707276062 } from '../../../src/database/migrations/1784707276062-CreateCredentials';
import { LedgerModule } from '../../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../../src/modules/ledger/ledger.service';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { Transaction } from '../../../src/modules/ledger/entities/transaction.entity';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { PaymentsModule } from '../../../src/modules/payments/payments.module';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';

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
  app: INestApplication<App>;
  usersService: UsersService;
  ledgerService: LedgerService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  accountRepo: Repository<Account>;
  transactionRepo: Repository<Transaction>;
  fakeAdapter: FakeAdapter;
}

// Real Postgres via Testcontainers, proving idempotent-retry behavior
// against the actual `UQ_transactions_reference` constraint, not a mock.
// No Redis/AuthModule/NotificationsModule here — PaymentsModule doesn't
// depend on the event bus or notifications (no domain event is published,
// no email sent, in this issue's scope), so this context stays lighter than
// auth-test-context.ts. Users are seeded directly via UsersService +
// LedgerService rather than through the real register() flow, since
// exercising registration itself isn't what these tests are about.
export async function createPaymentsTestContext(): Promise<PaymentsTestContext> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();

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
    redis: { url: 'redis://unused:6379' },
    sentry: { dsn: undefined },
    rateLimit: { ttlMs: 60_000, limit: 100 },
    jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
    encryption: { key: 'a'.repeat(64) },
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
    app,
    usersService: moduleRef.get(UsersService),
    ledgerService: moduleRef.get(LedgerService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    accountRepo: dataSource.getRepository(Account),
    transactionRepo: dataSource.getRepository(Transaction),
    fakeAdapter: moduleRef.get(PAYMENT_PROVIDER_ADAPTER),
  };
}

export async function destroyPaymentsTestContext(
  ctx: Partial<PaymentsTestContext>,
): Promise<void> {
  await ctx.app?.close();
  await ctx.postgres?.stop();
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
