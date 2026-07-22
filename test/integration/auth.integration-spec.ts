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
import { generate as generateTotpCode } from 'otplib';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { CreateUsersAndAccounts1784628665852 } from '../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { CreateSessions1784642459395 } from '../../src/database/migrations/1784642459395-CreateSessions';
import { CreatePushTokens1784616220824 } from '../../src/database/migrations/1784616220824-CreatePushTokens';
import { CreateMfaAndTrustedDevices1784652789887 } from '../../src/database/migrations/1784652789887-CreateMfaAndTrustedDevices';
import { CreateVerificationCodes1784672011426 } from '../../src/database/migrations/1784672011426-CreateVerificationCodes';
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { ConvertSessionsTimestamps1784707276058 } from '../../src/database/migrations/1784707276058-ConvertSessionsTimestamps';
import { ConvertPushTokensTimestamps1784707276059 } from '../../src/database/migrations/1784707276059-ConvertPushTokensTimestamps';
import { ConvertMfaAndTrustedDevicesTimestamps1784707276060 } from '../../src/database/migrations/1784707276060-ConvertMfaAndTrustedDevicesTimestamps';
import { seedSystemAccounts } from '../../src/database/seed-system-accounts';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AuthService } from '../../src/modules/auth/auth.service';
import { EnrollTotpResponseDto } from '../../src/modules/auth/dto/enroll-totp-response.dto';
import { LoginResponseDto } from '../../src/modules/auth/dto/login-response.dto';
import { RegisterDto } from '../../src/modules/auth/dto/register.dto';
import { TokenPairResponseDto } from '../../src/modules/auth/dto/token-pair-response.dto';
import { MfaChallenge } from '../../src/modules/auth/entities/mfa-challenge.entity';
import { MfaMethod } from '../../src/modules/auth/entities/mfa-method.entity';
import { Session } from '../../src/modules/auth/entities/session.entity';
import { TrustedDevice } from '../../src/modules/auth/entities/trusted-device.entity';
import { User } from '../../src/modules/auth/entities/user.entity';
import { VerificationCode } from '../../src/modules/auth/entities/verification-code.entity';
import {
  AccountLockedException,
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  InvalidMfaCodeException,
  InvalidRefreshTokenException,
  MfaChallengeInvalidException,
  MfaChallengeNotFoundException,
  PhoneAlreadyRegisteredException,
  SessionRevokedException,
  UsernameAlreadyTakenException,
  VerificationCodeInvalidException,
} from '../../src/modules/auth/internal/errors';
import { MfaService } from '../../src/modules/auth/mfa.service';
import { DeviceMetadata } from '../../src/modules/auth/internal/device-metadata.util';
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

// The MFA code is the only 6-digit run in the rendered email — see
// templates/email/mfa-challenge-otp.hbs.
function extractSixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) {
    throw new Error(`No 6-digit code found in email text: ${text}`);
  }
  return match[1];
}

// Deterministically wrong — collision-free, unlike picking a fixed guess
// that could rarely equal the real code.
function wrongCodeFor(correctCode: string): string {
  const next = (parseInt(correctCode, 10) + 1) % 1_000_000;
  return next.toString().padStart(6, '0');
}

// The verification link is the only `token=` query param in the rendered
// email — see templates/email/email-verification-otp.hbs.
function extractVerificationToken(text: string): string {
  const match = text.match(/token=([^&\s]+)/);
  if (!match) {
    throw new Error(`No verification token found in email text: ${text}`);
  }
  return decodeURIComponent(match[1]);
}

const TEST_DEVICE: DeviceMetadata = {
  ipAddress: '203.0.113.10',
  userAgent: 'jest-integration-test-agent',
};

// Real Postgres and a real Redis via Testcontainers, per docs/architecture.md
// §10 — proves register()/login()/refresh()/logout() and the MFA/trusted-device
// flow (issue #4) against the actual migrations' schema and constraints, not
// mocks. Redis is needed because AuthModule imports EventBusModule — both the
// refresh() reuse-detection alert and the MFA challenge email dispatch go
// through it; NotificationsModule is wired in alongside it so delivery can be
// asserted, not just that EventBusService was called.
describe('Auth module — registration against a real Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: INestApplication<App>;
  let authService: AuthService;
  let mfaService: MfaService;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let accountRepo: Repository<Account>;
  let sessionRepo: Repository<Session>;
  let mfaMethodRepo: Repository<MfaMethod>;
  let mfaChallengeRepo: Repository<MfaChallenge>;
  let trustedDeviceRepo: Repository<TrustedDevice>;
  let verificationCodeRepo: Repository<VerificationCode>;
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
    await new CreateMfaAndTrustedDevices1784652789887().up(queryRunner);
    await new CreateVerificationCodes1784672011426().up(queryRunner);
    await new ConvertUsersAndAccountsTimestamps1784707276057().up(queryRunner);
    await new ConvertSessionsTimestamps1784707276058().up(queryRunner);
    await new ConvertPushTokensTimestamps1784707276059().up(queryRunner);
    await new ConvertMfaAndTrustedDevicesTimestamps1784707276060().up(
      queryRunner,
    );
    await queryRunner.release();
    await setupDataSource.destroy();

    const config: AppConfig = {
      app: {
        env: 'test',
        port: 0,
        corsAllowedOrigins: [],
        emailVerificationUrl: 'http://localhost:3000/verify-email',
      },
      database: { url: postgres.getConnectionUri() },
      redis: {
        url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
      sentry: { dsn: undefined },
      rateLimit: { ttlMs: 60_000, limit: 100 },
      jwt: { secret: 'test-jwt-secret-at-least-32-characters-long' },
      encryption: {
        key: 'a'.repeat(64),
      },
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
    mfaService = moduleRef.get(MfaService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    accountRepo = dataSource.getRepository(Account);
    sessionRepo = dataSource.getRepository(Session);
    mfaMethodRepo = dataSource.getRepository(MfaMethod);
    mfaChallengeRepo = dataSource.getRepository(MfaChallenge);
    trustedDeviceRepo = dataSource.getRepository(TrustedDevice);
    verificationCodeRepo = dataSource.getRepository(VerificationCode);
    emailAdapter = moduleRef.get(EMAIL_SENDER);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  async function registerUser(overrides: Record<string, unknown> = {}) {
    return authService.register(registerPayload(overrides));
  }

  // login() forks on device trust (docs/architecture.md §3.8) — this drives
  // it through the untrusted-device path via the real email dispatch and
  // returns finished tokens, for tests that just need a working session.
  async function loginAndVerify(
    email: string,
    password: string,
  ): Promise<{ tokens: TokenPairResponseDto; trustedDeviceToken: string }> {
    const result = await authService.login(
      { email, password },
      null,
      TEST_DEVICE,
    );
    if (!result.mfaRequired) {
      throw new Error(
        'loginAndVerify expected an MFA challenge — device was unexpectedly already trusted',
      );
    }
    const code = extractSixDigitCode(emailAdapter.sent.at(-1)!.text);
    return authService.verifyMfaChallenge(
      { challengeId: result.challengeId, code },
      TEST_DEVICE,
    );
  }

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

    // Auto-enrolled, no separate call — see issue #4.
    const emailMethod = await mfaMethodRepo.findOneByOrFail({
      userId: user.id,
      type: 'email',
    });
    expect(emailMethod.status).toBe('active');
    expect(emailMethod.secretCiphertext).toBeNull();
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
    it('challenges on an untrusted device, then issues a token pair and a trusted session on verify', async () => {
      const { user } = await registerUser({
        email: 'login-ok@example.com',
        username: 'login_ok',
        phone: '+2348044444401',
      });

      const { tokens, trustedDeviceToken } = await loginAndVerify(
        'login-ok@example.com',
        'a-strong-unique-passphrase',
      );

      expect(tokens.tokenType).toBe('Bearer');
      expect(tokens.expiresIn).toBe(15 * 60);
      expect(typeof trustedDeviceToken).toBe('string');

      const session = await sessionRepo.findOneByOrFail({ userId: user.id });
      expect(session.status).toBe('active');
      expect(session.previousTokenHash).toBeNull();
      expect(session.currentTokenHash).toHaveLength(64); // sha256 hex
      expect(session.trustedDeviceId).not.toBeNull();
      expect(session.device).toEqual(TEST_DEVICE);

      const device = await trustedDeviceRepo.findOneByOrFail({
        id: session.trustedDeviceId!,
      });
      expect(device.userId).toBe(user.id);
      expect(device.device).toEqual(TEST_DEVICE);
    });

    it('rejects an unknown email and a wrong password identically, without creating a session', async () => {
      await registerUser({
        email: 'login-bad@example.com',
        username: 'login_bad',
        phone: '+2348044444402',
      });

      await expect(
        authService.login(
          { email: 'no-such-user@example.com', password: 'whatever' },
          null,
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);

      await expect(
        authService.login(
          { email: 'login-bad@example.com', password: 'wrong-password' },
          null,
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    });

    it('rotates the refresh token on refresh(), and the old token becomes a reuse signal', async () => {
      await registerUser({
        email: 'rotate@example.com',
        username: 'rotate_user',
        phone: '+2348044444403',
      });
      const { tokens } = await loginAndVerify(
        'rotate@example.com',
        'a-strong-unique-passphrase',
      );
      const firstToken = tokens.refreshToken;

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
      await loginAndVerify(
        'unknown-token@example.com',
        'a-strong-unique-passphrase',
      );

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
      const { tokens } = await loginAndVerify(
        'logout@example.com',
        'a-strong-unique-passphrase',
      );

      await authService.logout({ refreshToken: tokens.refreshToken });

      const session = await sessionRepo.findOneByOrFail({ userId: user.id });
      expect(session.status).toBe('revoked');
      await expect(
        authService.refresh({ refreshToken: tokens.refreshToken }),
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
          authService.login(
            { email: 'lockout@example.com', password: 'wrong-password' },
            null,
            TEST_DEVICE,
          ),
        ).rejects.toBeInstanceOf(InvalidCredentialsException);
      }

      // 5th failure locks the account.
      await expect(
        authService.login(
          { email: 'lockout@example.com', password: 'wrong-password' },
          null,
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);

      const locked = await userRepo.findOneByOrFail({
        email: 'lockout@example.com',
      });
      expect(locked.failedLoginAttempts).toBe(5);
      expect(locked.lockedUntil).toBeInstanceOf(Date);
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Even the correct password is rejected while locked.
      await expect(
        authService.login(
          {
            email: 'lockout@example.com',
            password: 'a-strong-unique-passphrase',
          },
          null,
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(AccountLockedException);
    });
  });

  describe('MFA enrollment, challenges, and trusted devices', () => {
    it('TOTP enroll-then-confirm activates the method, staying pending until a correct code is submitted', async () => {
      const { user } = await registerUser({
        email: 'totp@example.com',
        username: 'totp_user',
        phone: '+2348055555501',
      });

      const { secret, otpauthUrl } = await mfaService.enrollTotp(user.id);
      expect(otpauthUrl).toContain('otpauth://totp/');
      expect(otpauthUrl).toContain(encodeURIComponent(user.email));

      const pending = await mfaMethodRepo.findOneByOrFail({
        userId: user.id,
        type: 'totp',
      });
      expect(pending.status).toBe('pending');
      expect(pending.secretCiphertext).not.toBeNull();
      expect(pending.secretCiphertext).not.toBe(secret); // encrypted at rest

      const correctCode = await generateTotpCode({ secret });
      await expect(
        mfaService.confirmTotp(user.id, wrongCodeFor(correctCode)),
      ).rejects.toBeInstanceOf(InvalidMfaCodeException);
      expect(
        (await mfaMethodRepo.findOneByOrFail({ userId: user.id, type: 'totp' }))
          .status,
      ).toBe('pending');

      await mfaService.confirmTotp(user.id, correctCode);
      expect(
        (await mfaMethodRepo.findOneByOrFail({ userId: user.id, type: 'totp' }))
          .status,
      ).toBe('active');
    });

    it('login on an untrusted device creates a challenge; the wrong code is rejected and the right one succeeds', async () => {
      await registerUser({
        email: 'untrusted@example.com',
        username: 'untrusted_user',
        phone: '+2348055555502',
      });

      const result = await authService.login(
        {
          email: 'untrusted@example.com',
          password: 'a-strong-unique-passphrase',
        },
        null,
        TEST_DEVICE,
      );
      expect(result.mfaRequired).toBe(true);
      if (!result.mfaRequired) {
        throw new Error('expected a challenge');
      }
      expect(result.method).toBe('email');

      const correctCode = extractSixDigitCode(emailAdapter.sent.at(-1)!.text);

      await expect(
        authService.verifyMfaChallenge(
          { challengeId: result.challengeId, code: wrongCodeFor(correctCode) },
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidMfaCodeException);

      const { tokens, trustedDeviceToken } =
        await authService.verifyMfaChallenge(
          { challengeId: result.challengeId, code: correctCode },
          TEST_DEVICE,
        );
      expect(tokens.tokenType).toBe('Bearer');
      expect(typeof trustedDeviceToken).toBe('string');
    });

    it('login from a device with a valid trusted-device cookie skips the MFA challenge', async () => {
      const { user } = await registerUser({
        email: 'trusted@example.com',
        username: 'trusted_user',
        phone: '+2348055555503',
      });
      const { trustedDeviceToken } = await loginAndVerify(
        'trusted@example.com',
        'a-strong-unique-passphrase',
      );

      const emailsBefore = emailAdapter.sent.length;
      const result = await authService.login(
        {
          email: 'trusted@example.com',
          password: 'a-strong-unique-passphrase',
        },
        trustedDeviceToken,
        TEST_DEVICE,
      );

      expect(result.mfaRequired).toBe(false);
      expect(emailAdapter.sent.length).toBe(emailsBefore); // no new challenge sent
      if (result.mfaRequired) {
        throw new Error('expected the challenge to be skipped');
      }

      const sessions = await sessionRepo.find({
        where: { userId: user.id },
        order: { createdAt: 'DESC' },
      });
      expect(sessions[0].trustedDeviceId).not.toBeNull();
    });

    it('invalidates an MFA challenge after 5 wrong attempts, requiring a new one even with the right code', async () => {
      await registerUser({
        email: 'five-attempts@example.com',
        username: 'five_attempts_user',
        phone: '+2348055555504',
      });

      const result = await authService.login(
        {
          email: 'five-attempts@example.com',
          password: 'a-strong-unique-passphrase',
        },
        null,
        TEST_DEVICE,
      );
      if (!result.mfaRequired) {
        throw new Error('expected a challenge');
      }
      const correctCode = extractSixDigitCode(emailAdapter.sent.at(-1)!.text);
      const wrong = wrongCodeFor(correctCode);

      for (let i = 0; i < 5; i++) {
        await expect(
          authService.verifyMfaChallenge(
            { challengeId: result.challengeId, code: wrong },
            TEST_DEVICE,
          ),
        ).rejects.toBeInstanceOf(InvalidMfaCodeException);
      }

      const challenge = await mfaChallengeRepo.findOneByOrFail({
        id: result.challengeId,
      });
      expect(challenge.status).toBe('failed');
      expect(challenge.attempts).toBe(5);

      // Even the correct code no longer works — a new challenge is required.
      await expect(
        authService.verifyMfaChallenge(
          { challengeId: result.challengeId, code: correctCode },
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
    });

    it('rejects verification against a nonexistent challenge', async () => {
      await expect(
        authService.verifyMfaChallenge(
          {
            challengeId: '00000000-0000-0000-0000-000000000000',
            code: '123456',
          },
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(MfaChallengeNotFoundException);
    });
  });

  describe('MFA over HTTP — trusted-device cookie and the JWT guard', () => {
    it('sets an httpOnly trusted-device cookie on verify, and presenting it skips the next challenge', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'http-cookie@example.com',
          password: 'a-strong-unique-passphrase',
          firstName: 'Cookie',
          lastName: 'Monster',
          username: 'http_cookie_user',
          phone: '+2348055555599',
        })
        .expect(201);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .set('User-Agent', 'Cliqpay-Test-Client/1.0')
        .send({
          email: 'http-cookie@example.com',
          password: 'a-strong-unique-passphrase',
        })
        .expect(200);
      const loginBody = loginRes.body as LoginResponseDto;
      expect(loginBody.mfaRequired).toBe(true);
      if (!loginBody.mfaRequired) {
        throw new Error('expected a challenge');
      }
      const { challengeId } = loginBody;

      const code = extractSixDigitCode(emailAdapter.sent.at(-1)!.text);

      const verifyRes = await request(app.getHttpServer())
        .post('/mfa/verify')
        .set('User-Agent', 'Cliqpay-Test-Client/1.0')
        .send({ challengeId, code })
        .expect(200);

      const setCookieHeader = verifyRes.headers['set-cookie'] as unknown as
        | string[]
        | string;
      const cookies = ([] as string[]).concat(setCookieHeader);
      const trustedDeviceCookie = cookies.find((c) =>
        c.startsWith('cliqpay_trusted_device='),
      );
      expect(trustedDeviceCookie).toBeDefined();
      expect(trustedDeviceCookie).toContain('HttpOnly');
      expect(trustedDeviceCookie).toMatch(/SameSite=Lax/i);

      // Real request metadata, not the test-only TEST_DEVICE constant —
      // proves the controller actually reads req.ip/User-Agent rather than
      // relying on a fixed value (see ADR-0003).
      const httpCookieUser = await userRepo.findOneByOrFail({
        email: 'http-cookie@example.com',
      });
      const httpCookieDevice = await trustedDeviceRepo.findOneByOrFail({
        userId: httpCookieUser.id,
      });
      expect(httpCookieDevice.device.userAgent).toBe('Cliqpay-Test-Client/1.0');
      expect(httpCookieDevice.device.ipAddress).toEqual(expect.any(String));
      expect(httpCookieDevice.device.ipAddress.length).toBeGreaterThan(0);

      const cookieValue = trustedDeviceCookie!.split(';')[0];

      const secondLoginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Cookie', cookieValue)
        .send({
          email: 'http-cookie@example.com',
          password: 'a-strong-unique-passphrase',
        })
        .expect(200);
      const secondLoginBody = secondLoginRes.body as LoginResponseDto;
      expect(secondLoginBody.mfaRequired).toBe(false);
      if (secondLoginBody.mfaRequired) {
        throw new Error('expected the challenge to be skipped');
      }
      expect(secondLoginBody.tokenType).toBe('Bearer');
    });

    it('rejects an unauthenticated TOTP enroll request', async () => {
      await request(app.getHttpServer())
        .post('/mfa/totp/enroll')
        .send({})
        .expect(401);
    });

    it('accepts an authenticated TOTP enroll request', async () => {
      const { tokens } = await loginAndVerify(
        'http-cookie@example.com',
        'a-strong-unique-passphrase',
      );

      const res = await request(app.getHttpServer())
        .post('/mfa/totp/enroll')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(200);

      const body = res.body as EnrollTotpResponseDto;
      expect(body.secret).toBeDefined();
      expect(body.otpauthUrl).toContain('otpauth://totp/');
    });
  });

  describe('email verification', () => {
    it('sends a verification email on register and records an unused, expiring code', async () => {
      const { user } = await registerUser({
        email: 'verify-register@example.com',
        username: 'verify_register',
        phone: '+2348066666601',
      });

      const code = await verificationCodeRepo.findOneByOrFail({
        userId: user.id,
        purpose: 'email_verification',
      });
      expect(code.usedAt).toBeNull();
      expect(code.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const sent = emailAdapter.sent.find((m) => m.to === user.email);
      expect(sent).toBeDefined();
      expect(sent!.text).toContain('token=');
    });

    it('verifies with a valid token, sets emailVerifiedAt, and rejects reuse of the same token', async () => {
      const { user } = await registerUser({
        email: 'verify-ok@example.com',
        username: 'verify_ok',
        phone: '+2348066666602',
      });
      const token = extractVerificationToken(
        emailAdapter.sent.find((m) => m.to === user.email)!.text,
      );

      await authService.verifyEmail(token);

      const verified = await userRepo.findOneByOrFail({ id: user.id });
      expect(verified.emailVerifiedAt).toBeInstanceOf(Date);

      await expect(authService.verifyEmail(token)).rejects.toBeInstanceOf(
        VerificationCodeInvalidException,
      );
    });

    it('rejects an unrecognized token without setting emailVerifiedAt', async () => {
      const { user } = await registerUser({
        email: 'verify-bad@example.com',
        username: 'verify_bad',
        phone: '+2348066666603',
      });

      await expect(
        authService.verifyEmail('never-issued-token'),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidException);

      const unverified = await userRepo.findOneByOrFail({ id: user.id });
      expect(unverified.emailVerifiedAt).toBeNull();
    });

    it('POST /auth/verify-email works unauthenticated, and login is not gated on it', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'verify-http@example.com',
          password: 'a-strong-unique-passphrase',
          firstName: 'Verify',
          lastName: 'Http',
          username: 'verify_http_user',
          phone: '+2348066666604',
        })
        .expect(201);

      const token = extractVerificationToken(
        emailAdapter.sent.find((m) => m.to === 'verify-http@example.com')!.text,
      );

      await request(app.getHttpServer())
        .post('/auth/verify-email')
        .send({ token })
        .expect(200);

      const verified = await userRepo.findOneByOrFail({
        email: 'verify-http@example.com',
      });
      expect(verified.emailVerifiedAt).toBeInstanceOf(Date);

      // Nothing in Phase 1 gates login on emailVerifiedAt — a full login
      // still works even before this test's own verify above ran.
      const { tokens } = await loginAndVerify(
        'verify-http@example.com',
        'a-strong-unique-passphrase',
      );
      expect(tokens.tokenType).toBe('Bearer');
    });

    it('rejects an invalid/expired token over HTTP with a clear error, distinct from a malformed request', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-email')
        .send({ token: 'not-a-real-token' })
        .expect(410);
    });

    it('resend is authenticated and rate-limited to 60s since the last code (including the automatic one from registration)', async () => {
      const { user } = await registerUser({
        email: 'resend@example.com',
        username: 'resend_user',
        phone: '+2348066666605',
      });

      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .send({})
        .expect(401);

      const { tokens } = await loginAndVerify(
        'resend@example.com',
        'a-strong-unique-passphrase',
      );

      // The registration email was just sent — an immediate resend hits the
      // 60s cooldown against that same code.
      const emailsBefore = emailAdapter.sent.length;
      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(429);
      expect(emailAdapter.sent.length).toBe(emailsBefore);

      // Backdate that code's createdAt past the cooldown window to simulate
      // time passing, rather than sleeping the test for 60+ real seconds.
      await verificationCodeRepo.update(
        { userId: user.id, purpose: 'email_verification' },
        { createdAt: new Date(Date.now() - 61_000) },
      );

      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(204);
      expect(emailAdapter.sent.length).toBe(emailsBefore + 1);

      // Immediate second resend hits the 60s cooldown again.
      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(429);
      expect(emailAdapter.sent.length).toBe(emailsBefore + 1);

      // The most recently issued code (from the successful resend, not the
      // original registration send) still verifies correctly.
      const latestToken = extractVerificationToken(
        emailAdapter.sent.at(-1)!.text,
      );
      await request(app.getHttpServer())
        .post('/auth/verify-email')
        .send({ token: latestToken })
        .expect(200);
    });

    it('rejects resend for an already-verified user', async () => {
      const { user } = await registerUser({
        email: 'already-verified@example.com',
        username: 'already_verified_user',
        phone: '+2348066666606',
      });
      const token = extractVerificationToken(
        emailAdapter.sent.find((m) => m.to === user.email)!.text,
      );
      await authService.verifyEmail(token);

      const { tokens } = await loginAndVerify(
        'already-verified@example.com',
        'a-strong-unique-passphrase',
      );

      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(409);
    });
  });
});
