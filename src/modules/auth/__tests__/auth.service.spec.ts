import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { User } from '../entities/user.entity';
import { RegisterDto } from '../dto/register.dto';
import {
  EmailAlreadyRegisteredException,
  PhoneAlreadyRegisteredException,
  UsernameAlreadyTakenException,
} from '../internal/errors';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';

function buildDto(overrides: Partial<RegisterDto> = {}): RegisterDto {
  return Object.assign(new RegisterDto(), {
    email: 'ada@example.com',
    password: 'a-strong-unique-passphrase',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    phone: '+2348012345678',
    ...overrides,
  });
}

// TypeORM's real Repository.create/save are heavily overloaded (single vs
// array args) — jest.Mocked<Pick<Repository<T>, ...>> can't satisfy every
// overload with one mock implementation, so this only models the one
// signature AuthService actually calls.
interface FakeUserRepo {
  create: jest.Mock<User, [Partial<User>]>;
  save: jest.Mock<Promise<User>, [User]>;
}

describe('AuthService.register', () => {
  let userRepo: FakeUserRepo;
  let manager: { getRepository: jest.Mock<FakeUserRepo, unknown[]> };
  let dataSource: {
    transaction: jest.Mock<unknown, [(m: EntityManager) => unknown]>;
  };
  let ledgerService: {
    createUserWallet: jest.Mock<
      Promise<{ id: string; currency: string; balance: bigint }>,
      unknown[]
    >;
  };
  let mfaService: { enrollEmailMethod: jest.Mock<Promise<void>, unknown[]> };
  let eventBus: {
    publish: jest.Mock<Promise<void>, [DomainEventEnvelope<string, unknown>]>;
  };
  let verificationCodeService: {
    issue: jest.Mock<Promise<{ token: string; expiresAt: Date }>, unknown[]>;
  };
  let service: AuthService;

  beforeEach(() => {
    userRepo = {
      create: jest.fn(
        (data: Partial<User>) => ({ id: 'user-1', ...data }) as User,
      ),
      save: jest.fn((entity: User) => Promise.resolve(entity)),
    };
    manager = {
      getRepository: jest.fn(() => userRepo),
    };
    dataSource = {
      transaction: jest.fn((work: (m: EntityManager) => unknown) =>
        work(manager as unknown as EntityManager),
      ),
    };
    ledgerService = {
      createUserWallet: jest.fn(() =>
        Promise.resolve({ id: 'wallet-1', currency: 'NGN', balance: 0n }),
      ),
    };
    mfaService = { enrollEmailMethod: jest.fn(() => Promise.resolve()) };
    eventBus = {
      publish: jest.fn((_event: DomainEventEnvelope<string, unknown>) =>
        Promise.resolve(),
      ),
    };
    verificationCodeService = {
      issue: jest.fn(() =>
        Promise.resolve({
          token: 'raw-verification-token',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      ),
    };
    service = new AuthService(
      dataSource as unknown as DataSource,
      {
        app: { emailVerificationUrl: 'http://localhost:3000/verify-email' },
      } as unknown as AppConfig,
      ledgerService as unknown as LedgerService,
      { signAsync: jest.fn() } as unknown as JwtService,
      eventBus as unknown as EventBusService,
      mfaService as unknown as MfaService,
      verificationCodeService as unknown as VerificationCodeService,
    );
  });

  it('hashes the password with bcrypt, never returns it, and leaves the PIN unset', async () => {
    const dto = buildDto();

    const result = await service.register(dto);

    const savedUser = userRepo.save.mock.calls[0][0];
    expect(savedUser.passwordHash).not.toBe(dto.password);
    await expect(
      bcrypt.compare(dto.password, savedUser.passwordHash),
    ).resolves.toBe(true);
    expect(JSON.stringify(result)).not.toContain(savedUser.passwordHash);
  });

  it('creates the wallet inside the same transaction as the user insert', async () => {
    await service.register(buildDto());

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(ledgerService.createUserWallet).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'NGN',
    );
  });

  it('auto-enrolls email MFA in the same transaction as the user insert, no separate call', async () => {
    await service.register(buildDto());

    expect(mfaService.enrollEmailMethod).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
    );
  });

  it.each([
    ['UQ_users_email', EmailAlreadyRegisteredException],
    ['UQ_users_username', UsernameAlreadyTakenException],
    ['UQ_users_phone', PhoneAlreadyRegisteredException],
  ] as const)(
    'maps a %s unique violation to its specific domain exception',
    async (constraint, ExpectedException) => {
      userRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint,
        }),
      );

      await expect(service.register(buildDto())).rejects.toBeInstanceOf(
        ExpectedException,
      );
      expect(ledgerService.createUserWallet).not.toHaveBeenCalled();
    },
  );

  it('propagates a non-unique-violation error unchanged', async () => {
    const boom = new Error('connection lost');
    userRepo.save.mockRejectedValueOnce(boom);

    await expect(service.register(buildDto())).rejects.toBe(boom);
  });

  describe('email verification dispatch on register', () => {
    it('issues a code and publishes the verification email fire-and-forget after the transaction commits', async () => {
      await service.register(buildDto());

      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
        'email_verification',
        expect.any(Number),
      );

      const published = eventBus.publish.mock.calls[0]?.[0] as {
        name: string;
        payload: { userId: string; email: string; verificationUrl: string };
      };
      expect(published.name).toBe('email_verification_otp');
      expect(published.payload.userId).toBe('user-1');
      expect(published.payload.email).toBe('ada@example.com');
      expect(published.payload.verificationUrl).toContain(
        'token=raw-verification-token',
      );
    });

    // publish() only enqueues — a downstream send failure happens later,
    // inside the queue worker, and never reaches register() at all.
    it('still surfaces a failure to enqueue the event', async () => {
      eventBus.publish.mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(service.register(buildDto())).rejects.toThrow(
        'redis unreachable',
      );
    });
  });
});
