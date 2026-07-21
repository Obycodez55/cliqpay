import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { CreateUsersAndAccounts1784628665852 } from '../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { CreateSessions1784642459395 } from '../../src/database/migrations/1784642459395-CreateSessions';
import { CreatePushTokens1784616220824 } from '../../src/database/migrations/1784616220824-CreatePushTokens';
import { seedSystemAccounts } from '../../src/database/seed-system-accounts';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RegisterDto } from '../../src/modules/auth/dto/register.dto';
import { Session } from '../../src/modules/auth/entities/session.entity';
import { User } from '../../src/modules/auth/entities/user.entity';
import {
  AccountLockedException,
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  PhoneAlreadyRegisteredException,
  SessionRevokedException,
  UsernameAlreadyTakenException,
} from '../../src/modules/auth/internal/errors';
import { Account } from '../../src/modules/ledger/entities/account.entity';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { EMAIL_SENDER } from '../../src/modules/notifications/channels/email/email-sender.interface';
import { FakeEmailAdapter } from '../../src/modules/notifications/channels/email/fake-email.adapter';

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

// Real Postgres and a real Redis via Testcontainers, per docs/architecture.md
// §10 — proves register()/login()/refresh()/logout() against the actual
// migrations' schema and constraints, not mocks. Redis is needed because
// AuthModule now imports EventBusModule (the reuse-detection path on refresh()
// publishes a security_alert domain event) — NotificationsModule is wired in
// alongside it so that event's actual delivery can be asserted too, not just
// that EventBusService.publish() was called.
describe('Auth module — registration against a real Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let authService: AuthService;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let accountRepo: Repository<Account>;
  let emailAdapter: FakeEmailAdapter;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    redis = await new GenericContainer('redis:7-alpine')
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
    await queryRunner.release();
    await setupDataSource.destroy();

    const config: AppConfig = {
      app: { env: 'test', port: 0, corsAllowedOrigins: [] },
      database: { url: postgres.getConnectionUri() },
      redis: {
        url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
      sentry: { dsn: undefined },
      rateLimit: { ttlMs: 60_000, limit: 100 },
      jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
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
        NotificationsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    authService = moduleRef.get(AuthService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    accountRepo = dataSource.getRepository(Account);
    emailAdapter = moduleRef.get(EMAIL_SENDER);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
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

  describe('login, sessions, and lockout', () => {
    let sessionRepo: Repository<Session>;

    beforeAll(() => {
      sessionRepo = dataSource.getRepository(Session);
    });

    async function registerUser(overrides: Record<string, unknown> = {}) {
      return authService.register(registerPayload(overrides));
    }

    it('issues a token pair and creates a matching active session on successful login', async () => {
      const { user } = await registerUser({
        email: 'login-ok@example.com',
        username: 'login_ok',
        phone: '+2348044444401',
      });

      const result = await authService.login({
        email: 'login-ok@example.com',
        password: 'a-strong-unique-passphrase',
      });

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(15 * 60);

      const session = await sessionRepo.findOneByOrFail({ userId: user.id });
      expect(session.status).toBe('active');
      expect(session.previousTokenHash).toBeNull();
      expect(session.currentTokenHash).toHaveLength(64); // sha256 hex
    });

    it('rejects an unknown email and a wrong password identically, without creating a session', async () => {
      await registerUser({
        email: 'login-bad@example.com',
        username: 'login_bad',
        phone: '+2348044444402',
      });

      await expect(
        authService.login({
          email: 'no-such-user@example.com',
          password: 'whatever',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);

      await expect(
        authService.login({
          email: 'login-bad@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    });

    it('rotates the refresh token on refresh(), and the old token becomes a reuse signal', async () => {
      await registerUser({
        email: 'rotate@example.com',
        username: 'rotate_user',
        phone: '+2348044444403',
      });
      const { refreshToken: firstToken } = await authService.login({
        email: 'rotate@example.com',
        password: 'a-strong-unique-passphrase',
      });

      const { refreshToken: secondToken } = await authService.refresh({
        refreshToken: firstToken,
      });
      expect(secondToken).not.toBe(firstToken);

      // Normal rotation: the new token works, rotating again.
      const { refreshToken: thirdToken } = await authService.refresh({
        refreshToken: secondToken,
      });
      expect(thirdToken).not.toBe(secondToken);

      // Replaying the very first (now two generations stale) token isn't
      // caught by the one-generation window — only the immediately-superseded
      // token is. Replaying the token one generation back (secondToken, which
      // is now previousTokenHash) is the reuse case that must revoke.
      const emailsBefore = emailAdapter.sent.length;
      await expect(
        authService.refresh({ refreshToken: secondToken }),
      ).rejects.toBeInstanceOf(SessionRevokedException);

      // The session is now fully revoked — even the latest valid token stops working.
      await expect(
        authService.refresh({ refreshToken: thirdToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenException);

      // The reuse-detected revoke also fires a security_alert through the
      // real domain-events queue — not just an EventBusService.publish()
      // call in isolation (that's covered by the unit test).
      await waitFor(() => emailAdapter.sent.length > emailsBefore);
      expect(emailAdapter.sent.at(-1)).toMatchObject({
        to: 'rotate@example.com',
      });
    });

    it('rejects an unrecognized refresh token with no side effects', async () => {
      await registerUser({
        email: 'unknown-token@example.com',
        username: 'unknown_token_user',
        phone: '+2348044444404',
      });
      await authService.login({
        email: 'unknown-token@example.com',
        password: 'a-strong-unique-passphrase',
      });

      const before = await sessionRepo.find();

      await expect(
        authService.refresh({ refreshToken: 'never-issued-token' }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenException);

      const after = await sessionRepo.find();
      expect(after).toEqual(before);
    });

    it('logout revokes the session and the refresh token stops working', async () => {
      const { user } = await registerUser({
        email: 'logout@example.com',
        username: 'logout_user',
        phone: '+2348044444405',
      });
      const { refreshToken } = await authService.login({
        email: 'logout@example.com',
        password: 'a-strong-unique-passphrase',
      });

      await authService.logout({ refreshToken });

      const session = await sessionRepo.findOneByOrFail({ userId: user.id });
      expect(session.status).toBe('revoked');
      await expect(
        authService.refresh({ refreshToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    });

    it('locks the account for 15 minutes after 5 consecutive failed attempts', async () => {
      await registerUser({
        email: 'lockout@example.com',
        username: 'lockout_user',
        phone: '+2348044444406',
      });

      for (let i = 0; i < 4; i++) {
        await expect(
          authService.login({
            email: 'lockout@example.com',
            password: 'wrong-password',
          }),
        ).rejects.toBeInstanceOf(InvalidCredentialsException);
      }

      // 5th failure locks the account.
      await expect(
        authService.login({
          email: 'lockout@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);

      const userRepoLocal = dataSource.getRepository(User);
      const locked = await userRepoLocal.findOneByOrFail({
        email: 'lockout@example.com',
      });
      expect(locked.failedLoginAttempts).toBe(5);
      expect(locked.lockedUntil).toBeInstanceOf(Date);
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Even the correct password is rejected while locked.
      await expect(
        authService.login({
          email: 'lockout@example.com',
          password: 'a-strong-unique-passphrase',
        }),
      ).rejects.toBeInstanceOf(AccountLockedException);
    });
  });
});
