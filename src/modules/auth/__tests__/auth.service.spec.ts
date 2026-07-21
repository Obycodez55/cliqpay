import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { User } from '../entities/user.entity';
import { RegisterDto } from '../dto/register.dto';
import {
  EmailAlreadyRegisteredException,
  PhoneAlreadyRegisteredException,
  UsernameAlreadyTakenException,
} from '../internal/errors';

function buildDto(overrides: Partial<RegisterDto> = {}): RegisterDto {
  return Object.assign(new RegisterDto(), {
    email: 'ada@example.com',
    password: 'a-strong-unique-passphrase',
    pin: '1234',
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
    service = new AuthService(
      dataSource as unknown as DataSource,
      ledgerService as unknown as LedgerService,
    );
  });

  it('hashes the password and pin with bcrypt and never returns them', async () => {
    const dto = buildDto();

    const result = await service.register(dto);

    const savedUser = userRepo.save.mock.calls[0][0];
    expect(savedUser.passwordHash).not.toBe(dto.password);
    expect(savedUser.transactionPinHash).not.toBe(dto.pin);
    await expect(
      bcrypt.compare(dto.password, savedUser.passwordHash),
    ).resolves.toBe(true);
    await expect(
      bcrypt.compare(dto.pin, savedUser.transactionPinHash),
    ).resolves.toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(savedUser.passwordHash);
    expect(serialized).not.toContain(savedUser.transactionPinHash);
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
});
