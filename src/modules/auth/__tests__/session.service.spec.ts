import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager, FindOneOptions } from 'typeorm';
import { SessionService } from '../session.service';
import { UsersService } from '../../users/users.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Credential } from '../entities/credential.entity';
import { Session } from '../entities/session.entity';
import { TrustedDevice } from '../entities/trusted-device.entity';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { LogoutDto } from '../dto/logout.dto';
import {
  AccountLockedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
} from '../internal/errors';
import { MfaService } from '../mfa.service';
import { hashOpaqueToken } from '../internal/secrets.util';
import { DeviceMetadata } from '../internal/device-metadata.util';

const TEST_DEVICE: DeviceMetadata = {
  ipAddress: '203.0.113.10',
  userAgent: 'jest-test-agent',
};

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const bcryptCompare = bcrypt.compare as jest.Mock<
  Promise<boolean>,
  [string, string]
>;

// Structural, not `users.User` — auth's tests can't import another core
// module's entity (only its exported service), same reasoning as
// MfaService's own narrowed parameter types.
interface UserFixture {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  usernameChangedAt: Date | null;
  phone: string;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
}

function buildUser(overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    usernameChangedAt: null,
    phone: '+2348012345678',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    ...overrides,
  };
}

function buildCredential(overrides: Partial<Credential> = {}): Credential {
  return Object.assign(new Credential(), {
    id: 'credential-1',
    userId: 'user-1',
    passwordHash: 'hashed-password',
    transactionPinHash: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  });
}

function buildTrustedDevice(
  overrides: Partial<TrustedDevice> = {},
): TrustedDevice {
  return Object.assign(new TrustedDevice(), {
    id: 'device-1',
    userId: 'user-1',
    tokenHash: 'device-token-hash',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    lastUsedAt: new Date(),
    ...overrides,
  });
}

function buildSession(overrides: Partial<Session> = {}): Session {
  return Object.assign(new Session(), {
    id: 'session-1',
    userId: 'user-1',
    currentTokenHash: 'current-hash',
    previousTokenHash: null,
    status: 'active',
    trustedDeviceId: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    lastUsedAt: new Date(),
    ...overrides,
  });
}

interface FakeCredentialRepo {
  findOneByOrFail: jest.Mock<Promise<Credential>, [Partial<Credential>]>;
  save: jest.Mock<Promise<Credential>, [Credential]>;
}

interface FakeSessionRepo {
  create: jest.Mock<Session, [Partial<Session>]>;
  save: jest.Mock<Promise<Session>, [Session]>;
  findOneBy: jest.Mock<Promise<Session | null>, [Partial<Session>]>;
  findOne: jest.Mock<Promise<Session | null>, [FindOneOptions<Session>]>;
}

describe('SessionService — login, refresh, logout', () => {
  let usersService: {
    findByEmail: jest.Mock<Promise<UserFixture | null>, [string]>;
    findById: jest.Mock<Promise<UserFixture>, [string]>;
  };
  let credentialRepo: FakeCredentialRepo;
  let sessionRepo: FakeSessionRepo;
  let manager: { getRepository: jest.Mock<unknown, [unknown]> };
  let dataSource: {
    getRepository: jest.Mock<unknown, [unknown]>;
    transaction: jest.Mock<unknown, [(m: EntityManager) => unknown]>;
  };
  let jwtService: { signAsync: jest.Mock<Promise<string>, unknown[]> };
  let eventBus: { publish: jest.Mock<Promise<void>, unknown[]> };
  let mfaService: {
    findValidTrustedDevice: jest.Mock<Promise<TrustedDevice | null>, unknown[]>;
    touchTrustedDevice: jest.Mock<Promise<void>, unknown[]>;
    createChallengeForLogin: jest.Mock<
      Promise<{
        challengeId: string;
        method: 'email' | 'totp';
        expiresAt: Date;
      }>,
      unknown[]
    >;
    issueTrustedDevice: jest.Mock<
      Promise<{ device: TrustedDevice; rawToken: string }>,
      unknown[]
    >;
  };
  let service: SessionService;
  let existingUser: UserFixture;
  let existingCredential: Credential;

  beforeEach(() => {
    existingUser = buildUser();
    existingCredential = buildCredential();
    usersService = {
      findByEmail: jest.fn((_email: string) => Promise.resolve(existingUser)),
      findById: jest.fn((_userId: string) => Promise.resolve(existingUser)),
    };
    credentialRepo = {
      findOneByOrFail: jest.fn((_where: Partial<Credential>) =>
        Promise.resolve(existingCredential),
      ),
      save: jest.fn((entity: Credential) => Promise.resolve(entity)),
    };
    sessionRepo = {
      create: jest.fn((data: Partial<Session>) =>
        Object.assign(new Session(), { id: 'session-1', ...data }),
      ),
      save: jest.fn((entity: Session) => Promise.resolve(entity)),
      findOneBy: jest.fn((_where: Partial<Session>) => Promise.resolve(null)),
      findOne: jest.fn((_options: FindOneOptions<Session>) =>
        Promise.resolve(null),
      ),
    };
    const repoFor = (entity: unknown) =>
      entity === Session ? sessionRepo : credentialRepo;
    manager = { getRepository: jest.fn(repoFor) };
    dataSource = {
      getRepository: jest.fn(repoFor),
      transaction: jest.fn((work: (m: EntityManager) => unknown) =>
        work(manager as unknown as EntityManager),
      ),
    };
    jwtService = {
      signAsync: jest.fn(() => Promise.resolve('signed.jwt.token')),
    };
    eventBus = { publish: jest.fn(() => Promise.resolve()) };
    mfaService = {
      // Default: no trusted device — most login tests below exercise the
      // password/lockout logic, which runs before the device-trust check.
      findValidTrustedDevice: jest.fn(() => Promise.resolve(null)),
      touchTrustedDevice: jest.fn(() => Promise.resolve()),
      createChallengeForLogin: jest.fn(() =>
        Promise.resolve({
          challengeId: 'challenge-1',
          method: 'email' as const,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }),
      ),
      issueTrustedDevice: jest.fn(() =>
        Promise.resolve({
          device: buildTrustedDevice(),
          rawToken: 'raw-trusted-device-token',
        }),
      ),
    };
    bcryptCompare.mockReset();
    service = new SessionService(
      dataSource as unknown as DataSource,
      usersService as unknown as UsersService,
      jwtService as unknown as JwtService,
      eventBus as unknown as EventBusService,
      mfaService as unknown as MfaService,
    );
  });

  function loginDto(overrides: Partial<LoginDto> = {}): LoginDto {
    return Object.assign(new LoginDto(), {
      email: 'ada@example.com',
      password: 'a-strong-unique-passphrase',
      ...overrides,
    });
  }

  describe('login', () => {
    it('rejects an unknown email without touching any credential row', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        service.login(loginDto(), null, TEST_DEVICE),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a locked account before comparing the password', async () => {
      existingCredential.lockedUntil = new Date(Date.now() + 60_000);

      await expect(
        service.login(loginDto(), null, TEST_DEVICE),
      ).rejects.toBeInstanceOf(AccountLockedException);
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('increments failedLoginAttempts on a wrong password', async () => {
      existingCredential.failedLoginAttempts = 2;
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(
        service.login(loginDto(), null, TEST_DEVICE),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 3, lockedUntil: null }),
      );
    });

    it('locks the account for 15 minutes on the 5th consecutive failure', async () => {
      existingCredential.failedLoginAttempts = 4;
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(
        service.login(loginDto(), null, TEST_DEVICE),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
      const saved = credentialRepo.save.mock.calls[0][0];
      expect(saved.failedLoginAttempts).toBe(5);
      expect(saved.lockedUntil).toBeInstanceOf(Date);
      expect(saved.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it('gives a fresh attempt count once the lockout window has passed', async () => {
      existingCredential.failedLoginAttempts = 5;
      existingCredential.lockedUntil = new Date(Date.now() - 1000);
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(
        service.login(loginDto(), null, TEST_DEVICE),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
      const saved = credentialRepo.save.mock.calls[0][0];
      expect(saved.failedLoginAttempts).toBe(1);
      expect(saved.lockedUntil).toBeNull();
    });

    it('creates an MFA challenge instead of issuing tokens when no device is trusted', async () => {
      existingCredential.failedLoginAttempts = 3;
      bcryptCompare.mockResolvedValueOnce(true);

      const result = await service.login(loginDto(), null, TEST_DEVICE);

      expect(result.mfaRequired).toBe(true);
      if (!result.mfaRequired) {
        throw new Error('expected an MFA challenge, got tokens');
      }
      expect(result.challengeId).toBe('challenge-1');
      expect(result.method).toBe('email');
      expect(mfaService.createChallengeForLogin).toHaveBeenCalledWith(
        existingUser,
      );
      expect(sessionRepo.create).not.toHaveBeenCalled();

      // The password was still correct — lockout state resets regardless
      // of what MFA does next.
      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      );
    });

    it('resets lockout state and issues a token pair when the presented device is already trusted', async () => {
      existingCredential.failedLoginAttempts = 3;
      bcryptCompare.mockResolvedValueOnce(true);
      const trustedDevice = buildTrustedDevice();
      mfaService.findValidTrustedDevice.mockResolvedValueOnce(trustedDevice);

      const result = await service.login(
        loginDto(),
        'raw-trusted-device-token',
        TEST_DEVICE,
      );

      expect(result.mfaRequired).toBe(false);
      if (result.mfaRequired) {
        throw new Error('expected tokens, got an MFA challenge');
      }
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(15 * 60);
      expect(typeof result.refreshToken).toBe('string');
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        { sub: 'user-1', sid: 'session-1' },
        { expiresIn: 15 * 60 },
      );

      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      );
      expect(mfaService.touchTrustedDevice).toHaveBeenCalledWith(
        expect.anything(),
        trustedDevice,
        expect.any(Date),
      );

      const savedSession = sessionRepo.save.mock.calls[0][0];
      expect(savedSession.currentTokenHash).toBe(
        hashOpaqueToken(result.refreshToken),
      );
      expect(savedSession.previousTokenHash).toBeNull();
      expect(savedSession.status).toBe('active');
      expect(savedSession.trustedDeviceId).toBe('device-1');
      expect(savedSession.device).toEqual(TEST_DEVICE);
    });
  });

  describe('refresh', () => {
    function refreshDto(refreshToken: string): RefreshDto {
      return Object.assign(new RefreshDto(), { refreshToken });
    }

    it('rotates the session when the token matches currentTokenHash', async () => {
      const oldToken = 'old-refresh-token';
      const session = buildSession({
        currentTokenHash: hashOpaqueToken(oldToken),
      });
      sessionRepo.findOneBy.mockImplementation((where: Partial<Session>) =>
        Promise.resolve(
          where.currentTokenHash === session.currentTokenHash ? session : null,
        ),
      );

      const result = await service.refresh(refreshDto(oldToken));

      expect(sessionRepo.save).toHaveBeenCalledTimes(1);
      const saved = sessionRepo.save.mock.calls[0][0];
      expect(saved.previousTokenHash).toBe(hashOpaqueToken(oldToken));
      expect(saved.currentTokenHash).toBe(hashOpaqueToken(result.refreshToken));
      expect(saved.currentTokenHash).not.toBe(saved.previousTokenHash);
    });

    it('revokes the whole session and alerts the user when a previous (already-rotated) token is replayed', async () => {
      const staleToken = 'stale-refresh-token';
      const session = buildSession({
        currentTokenHash: 'some-newer-hash',
        previousTokenHash: hashOpaqueToken(staleToken),
      });
      sessionRepo.findOneBy.mockResolvedValueOnce(null); // no current-hash match
      sessionRepo.findOne.mockImplementation(
        (options: FindOneOptions<Session>) => {
          const where = options.where as Partial<Session> | undefined;
          if (where?.previousTokenHash === session.previousTokenHash) {
            return Promise.resolve(session);
          }
          return Promise.resolve(null);
        },
      );

      await expect(
        service.refresh(refreshDto(staleToken)),
      ).rejects.toBeInstanceOf(SessionRevokedException);
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'revoked' }),
      );
      expect(usersService.findById).toHaveBeenCalledWith(session.userId);
      const publishedEvent = eventBus.publish.mock.calls[0]?.[0] as {
        name: string;
        payload: { userId: string; email: string; message: string };
      };
      expect(publishedEvent.name).toBe('security_alert');
      expect(publishedEvent.payload.userId).toBe(session.userId);
      expect(publishedEvent.payload.email).toBe(existingUser.email);
    });

    it('rejects an unrecognized token with no side effect', async () => {
      sessionRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.refresh(refreshDto('never-issued-token')),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenException);
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    function logoutDto(refreshToken: string): LogoutDto {
      return Object.assign(new LogoutDto(), { refreshToken });
    }

    it('revokes the session matching the presented refresh token', async () => {
      const token = 'a-live-refresh-token';
      const session = buildSession({
        currentTokenHash: hashOpaqueToken(token),
      });
      sessionRepo.findOneBy.mockResolvedValueOnce(session);

      await service.logout(logoutDto(token));

      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'revoked' }),
      );
    });

    it('rejects an unrecognized token with no side effect', async () => {
      sessionRepo.findOneBy.mockResolvedValueOnce(null);

      await expect(
        service.logout(logoutDto('never-issued-token')),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenException);
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });
  });
});
