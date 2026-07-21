import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager } from 'typeorm';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { Session } from '../entities/session.entity';
import { User } from '../entities/user.entity';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { LogoutDto } from '../dto/logout.dto';
import {
  AccountLockedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
} from '../internal/errors';
import { hashRefreshToken } from '../internal/refresh-token.util';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const bcryptCompare = bcrypt.compare as jest.Mock<
  Promise<boolean>,
  [string, string]
>;

function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 'user-1',
    email: 'ada@example.com',
    passwordHash: 'hashed-password',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    phone: '+2348012345678',
    transactionPinHash: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
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

interface FakeUserRepo {
  findOneBy: jest.Mock<Promise<User | null>, [Partial<User>]>;
  save: jest.Mock<Promise<User>, [User]>;
}

interface FakeSessionRepo {
  create: jest.Mock<Session, [Partial<Session>]>;
  save: jest.Mock<Promise<Session>, [Session]>;
  findOneBy: jest.Mock<Promise<Session | null>, [Partial<Session>]>;
}

describe('AuthService — login, refresh, logout', () => {
  let userRepo: FakeUserRepo;
  let sessionRepo: FakeSessionRepo;
  let manager: { getRepository: jest.Mock<unknown, [unknown]> };
  let dataSource: {
    getRepository: jest.Mock<unknown, [unknown]>;
    transaction: jest.Mock<unknown, [(m: EntityManager) => unknown]>;
  };
  let jwtService: { signAsync: jest.Mock<Promise<string>, unknown[]> };
  let service: AuthService;
  let existingUser: User;

  beforeEach(() => {
    existingUser = buildUser();
    userRepo = {
      findOneBy: jest.fn((_where: Partial<User>) =>
        Promise.resolve(existingUser),
      ),
      save: jest.fn((entity: User) => Promise.resolve(entity)),
    };
    sessionRepo = {
      create: jest.fn((data: Partial<Session>) =>
        Object.assign(new Session(), { id: 'session-1', ...data }),
      ),
      save: jest.fn((entity: Session) => Promise.resolve(entity)),
      findOneBy: jest.fn((_where: Partial<Session>) => Promise.resolve(null)),
    };
    const repoFor = (entity: unknown) =>
      entity === User ? userRepo : sessionRepo;
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
    bcryptCompare.mockReset();
    service = new AuthService(
      dataSource as unknown as DataSource,
      {} as LedgerService,
      jwtService as unknown as JwtService,
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
    it('rejects an unknown email without touching any user row', async () => {
      userRepo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(
        InvalidCredentialsException,
      );
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a locked account before comparing the password', async () => {
      existingUser.lockedUntil = new Date(Date.now() + 60_000);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(
        AccountLockedException,
      );
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('increments failedLoginAttempts on a wrong password', async () => {
      existingUser.failedLoginAttempts = 2;
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(
        InvalidCredentialsException,
      );
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 3, lockedUntil: null }),
      );
    });

    it('locks the account for 15 minutes on the 5th consecutive failure', async () => {
      existingUser.failedLoginAttempts = 4;
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(
        InvalidCredentialsException,
      );
      const saved = userRepo.save.mock.calls[0][0];
      expect(saved.failedLoginAttempts).toBe(5);
      expect(saved.lockedUntil).toBeInstanceOf(Date);
      expect(saved.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it('gives a fresh attempt count once the lockout window has passed', async () => {
      existingUser.failedLoginAttempts = 5;
      existingUser.lockedUntil = new Date(Date.now() - 1000);
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(service.login(loginDto())).rejects.toBeInstanceOf(
        InvalidCredentialsException,
      );
      const saved = userRepo.save.mock.calls[0][0];
      expect(saved.failedLoginAttempts).toBe(1);
      expect(saved.lockedUntil).toBeNull();
    });

    it('resets lockout state and issues a token pair on success', async () => {
      existingUser.failedLoginAttempts = 3;
      bcryptCompare.mockResolvedValueOnce(true);

      const result = await service.login(loginDto());

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(15 * 60);
      expect(typeof result.refreshToken).toBe('string');
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        { sub: 'user-1', sid: 'session-1' },
        { expiresIn: 15 * 60 },
      );

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      );

      const savedSession = sessionRepo.save.mock.calls[0][0];
      expect(savedSession.currentTokenHash).toBe(
        hashRefreshToken(result.refreshToken),
      );
      expect(savedSession.previousTokenHash).toBeNull();
      expect(savedSession.status).toBe('active');
    });
  });

  describe('refresh', () => {
    function refreshDto(refreshToken: string): RefreshDto {
      return Object.assign(new RefreshDto(), { refreshToken });
    }

    it('rotates the session when the token matches currentTokenHash', async () => {
      const oldToken = 'old-refresh-token';
      const session = buildSession({
        currentTokenHash: hashRefreshToken(oldToken),
      });
      sessionRepo.findOneBy.mockImplementation((where: Partial<Session>) =>
        Promise.resolve(
          where.currentTokenHash === session.currentTokenHash ? session : null,
        ),
      );

      const result = await service.refresh(refreshDto(oldToken));

      expect(sessionRepo.save).toHaveBeenCalledTimes(1);
      const saved = sessionRepo.save.mock.calls[0][0];
      expect(saved.previousTokenHash).toBe(hashRefreshToken(oldToken));
      expect(saved.currentTokenHash).toBe(
        hashRefreshToken(result.refreshToken),
      );
      expect(saved.currentTokenHash).not.toBe(saved.previousTokenHash);
    });

    it('revokes the whole session when a previous (already-rotated) token is replayed', async () => {
      const staleToken = 'stale-refresh-token';
      const session = buildSession({
        currentTokenHash: 'some-newer-hash',
        previousTokenHash: hashRefreshToken(staleToken),
      });
      sessionRepo.findOneBy.mockImplementation((where: Partial<Session>) => {
        if (where.currentTokenHash) return Promise.resolve(null);
        if (where.previousTokenHash === session.previousTokenHash) {
          return Promise.resolve(session);
        }
        return Promise.resolve(null);
      });

      await expect(
        service.refresh(refreshDto(staleToken)),
      ).rejects.toBeInstanceOf(SessionRevokedException);
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'revoked' }),
      );
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
        currentTokenHash: hashRefreshToken(token),
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
