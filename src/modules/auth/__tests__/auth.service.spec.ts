import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { Credential } from '../entities/credential.entity';
import { RegisterDto } from '../dto/register.dto';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';
import { TransactionPinService } from '../transaction-pin.service';

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
  createdAt: Date;
  updatedAt: Date;
}

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

function buildCreatedUser(overrides: Partial<UserFixture> = {}): UserFixture {
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// TypeORM's real Repository.create/save are heavily overloaded (single vs
// array args) — jest.Mocked<Pick<Repository<T>, ...>> can't satisfy every
// overload with one mock implementation, so this only models the one
// signature AuthService actually calls.
interface FakeCredentialRepo {
  create: jest.Mock<Credential, [Partial<Credential>]>;
  save: jest.Mock<Promise<Credential>, [Credential]>;
}

describe('AuthService.register', () => {
  let credentialRepo: FakeCredentialRepo;
  let manager: { getRepository: jest.Mock<FakeCredentialRepo, unknown[]> };
  let dataSource: {
    transaction: jest.Mock<unknown, [(m: EntityManager) => unknown]>;
  };
  let usersService: {
    createUser: jest.Mock<Promise<UserFixture>, [EntityManager, unknown]>;
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
    credentialRepo = {
      create: jest.fn(
        (data: Partial<Credential>) =>
          ({ id: 'credential-1', ...data }) as Credential,
      ),
      save: jest.fn((entity: Credential) => Promise.resolve(entity)),
    };
    manager = {
      getRepository: jest.fn(() => credentialRepo),
    };
    dataSource = {
      transaction: jest.fn((work: (m: EntityManager) => unknown) =>
        work(manager as unknown as EntityManager),
      ),
    };
    usersService = {
      createUser: jest.fn((_manager: EntityManager, _data: unknown) =>
        Promise.resolve(buildCreatedUser()),
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
      usersService as unknown as UsersService,
      ledgerService as unknown as LedgerService,
      eventBus as unknown as EventBusService,
      mfaService as unknown as MfaService,
      verificationCodeService as unknown as VerificationCodeService,
      {} as TransactionPinService,
    );
  });

  it('creates the user via UsersService inside the transaction, then hashes the password onto Credential, never returning it', async () => {
    const dto = buildDto();

    const result = await service.register(dto);

    expect(usersService.createUser).toHaveBeenCalledWith(expect.anything(), {
      email: dto.email,
      phone: dto.phone,
      username: dto.username,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    const savedCredential = credentialRepo.save.mock.calls[0][0];
    expect(savedCredential.userId).toBe('user-1');
    expect(savedCredential.passwordHash).not.toBe(dto.password);
    await expect(
      bcrypt.compare(dto.password, savedCredential.passwordHash),
    ).resolves.toBe(true);
    expect(JSON.stringify(result)).not.toContain(savedCredential.passwordHash);
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

  // The specific unique-violation → domain-exception mapping is now
  // UsersService's own concern (see users.service.spec.ts) — AuthService
  // only needs to propagate whatever UsersService.createUser rejects with,
  // unchanged, and skip the wallet/MFA/credential steps that would
  // otherwise follow.
  it('propagates a rejection from UsersService.createUser and creates neither a credential nor a wallet', async () => {
    const boom = new Error('email already registered');
    usersService.createUser.mockRejectedValueOnce(boom);

    await expect(service.register(buildDto())).rejects.toBe(boom);
    expect(credentialRepo.save).not.toHaveBeenCalled();
    expect(ledgerService.createUserWallet).not.toHaveBeenCalled();
  });

  describe('email verification dispatch on register', () => {
    it('issues a code and publishes the verification email fire-and-forget after the transaction commits', async () => {
      await service.register(buildDto());

      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
        'email_verification',
        expect.any(Number),
        'numeric',
      );

      const published = eventBus.publish.mock.calls[0]?.[0] as {
        name: string;
        payload: { userId: string; email: string; code: string };
      };
      expect(published.name).toBe('email_verification_otp');
      expect(published.payload.userId).toBe('user-1');
      expect(published.payload.email).toBe('ada@example.com');
      expect(published.payload.code).toBe('raw-verification-token');
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

describe('AuthService.verifyTransactionPin', () => {
  // #22 (send-money) only ever calls AuthService.verifyTransactionPin, per
  // ADR-0009 — this is the one seam that must keep delegating to
  // TransactionPinService after the extraction, so it gets its own
  // regression test rather than relying on TransactionPinService's own spec.
  it('delegates to TransactionPinService.verifyTransactionPin', async () => {
    const transactionPinService = {
      verifyTransactionPin: jest.fn(() => Promise.resolve()),
    };
    const service = new AuthService(
      {} as unknown as DataSource,
      {} as UsersService,
      {} as LedgerService,
      {} as EventBusService,
      {} as MfaService,
      {} as VerificationCodeService,
      transactionPinService as unknown as TransactionPinService,
    );

    await service.verifyTransactionPin('user-1', '4837');

    expect(transactionPinService.verifyTransactionPin).toHaveBeenCalledWith(
      'user-1',
      '4837',
    );
  });
});
