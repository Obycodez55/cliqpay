import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { CreateUsersAndAccounts1784628665852 } from '../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { seedSystemAccounts } from '../../src/database/seed-system-accounts';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RegisterDto } from '../../src/modules/auth/dto/register.dto';
import { User } from '../../src/modules/auth/entities/user.entity';
import {
  EmailAlreadyRegisteredException,
  PhoneAlreadyRegisteredException,
  UsernameAlreadyTakenException,
} from '../../src/modules/auth/internal/errors';
import { Account } from '../../src/modules/ledger/entities/account.entity';

jest.setTimeout(120_000);

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

function registerPayload(overrides: Record<string, unknown> = {}): RegisterDto {
  return plainToInstance(RegisterDto, {
    email: 'ada@example.com',
    password: 'a-strong-unique-passphrase',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    phone: '+2348012345678',
    ...overrides,
  });
}

// Real Postgres via Testcontainers, per docs/architecture.md §10 — proves
// register() against the actual migration's schema and constraints, not a
// mock. AuthModule/LedgerModule don't touch Redis/BullMQ, so no Redis
// container is needed here (unlike the notifications integration spec).
describe('Auth module — registration against a real Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let authService: AuthService;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let accountRepo: Repository<Account>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();

    const setupDataSource = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      synchronize: false,
    });
    await setupDataSource.initialize();
    const queryRunner = setupDataSource.createQueryRunner();
    await new CreateUsersAndAccounts1784628665852().up(queryRunner);
    await queryRunner.release();
    await setupDataSource.destroy();

    const config: AppConfig = {
      app: { env: 'test', port: 0, corsAllowedOrigins: [] },
      database: { url: postgres.getConnectionUri() },
      redis: { url: 'redis://localhost:6379' },
      sentry: { dsn: undefined },
      rateLimit: { ttlMs: 60_000, limit: 100 },
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
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildTestConfigModule(config),
        TypeOrmModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (cfg: AppConfig) => buildDataSourceOptions(cfg),
        }),
        AuthModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    authService = moduleRef.get(AuthService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    accountRepo = dataSource.getRepository(Account);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  it('creates the user and a matching zero-balance NGN wallet atomically', async () => {
    const response = await authService.register(
      registerPayload({ username: 'AdaLovelace' }),
    );

    const user = await userRepo.findOneByOrFail({ id: response.user.id });
    expect(user.email).toBe('ada@example.com');
    expect(user.username).toBe('adalovelace');
    expect(user.phone).toBe('+2348012345678');
    await expect(
      bcrypt.compare('a-strong-unique-passphrase', user.passwordHash),
    ).resolves.toBe(true);
    expect(user.transactionPinHash).toBeNull();

    const wallet = await accountRepo.findOneByOrFail({
      userId: user.id,
      role: 'user_wallet',
    });
    expect(wallet.type).toBe('liability');
    expect(wallet.provider).toBeNull();
    expect(wallet.currency).toBe('NGN');
    expect(wallet.balance).toBe(0n);

    expect(response.wallet.balance).toEqual({ amount: '0', currency: 'NGN' });
    expect(JSON.stringify(response)).not.toContain(user.passwordHash);
  });

  it('rejects a duplicate email and leaves no extra rows', async () => {
    await authService.register(
      registerPayload({
        email: 'dup-email@example.com',
        username: 'dup_email_1',
        phone: '+2348011111111',
      }),
    );

    await expect(
      authService.register(
        registerPayload({
          email: 'dup-email@example.com',
          username: 'dup_email_2',
          phone: '+2348011111112',
        }),
      ),
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredException);

    expect(await userRepo.countBy({ email: 'dup-email@example.com' })).toBe(1);
  });

  it('rejects a duplicate username regardless of case', async () => {
    await authService.register(
      registerPayload({
        email: 'user-a@example.com',
        username: 'dupuser',
        phone: '+2348022222221',
      }),
    );

    await expect(
      authService.register(
        registerPayload({
          email: 'user-b@example.com',
          username: 'DupUser',
          phone: '+2348022222222',
        }),
      ),
    ).rejects.toBeInstanceOf(UsernameAlreadyTakenException);

    expect(await userRepo.countBy({ username: 'dupuser' })).toBe(1);
  });

  it('rejects a duplicate phone and leaves no extra rows', async () => {
    await authService.register(
      registerPayload({
        email: 'phone-a@example.com',
        username: 'phone_user_a',
        phone: '+2348033333333',
      }),
    );

    await expect(
      authService.register(
        registerPayload({
          email: 'phone-b@example.com',
          username: 'phone_user_b',
          phone: '+2348033333333',
        }),
      ),
    ).rejects.toBeInstanceOf(PhoneAlreadyRegisteredException);

    expect(await userRepo.countBy({ phone: '+2348033333333' })).toBe(1);
  });

  it('seeds NGN system accounts via migration, idempotently', async () => {
    const float = await accountRepo.findOneByOrFail({
      role: 'float',
      currency: 'NGN',
    });
    expect(float.type).toBe('asset');
    expect(float.provider).toBe('kora');
    expect(float.userId).toBeNull();

    const feeIncome = await accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });
    expect(feeIncome.type).toBe('equity');
    expect(feeIncome.provider).toBeNull();

    const beforeCount = await accountRepo.countBy({
      role: 'float',
      currency: 'NGN',
    });
    const queryRunner = dataSource.createQueryRunner();
    await seedSystemAccounts(queryRunner, 'NGN');
    await queryRunner.release();
    const afterCount = await accountRepo.countBy({
      role: 'float',
      currency: 'NGN',
    });

    expect(afterCount).toBe(beforeCount);
    expect(afterCount).toBe(1);
  });
});
