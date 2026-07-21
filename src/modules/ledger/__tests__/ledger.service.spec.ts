import { EntityManager } from 'typeorm';
import { LedgerService } from '../ledger.service';
import { Account } from '../entities/account.entity';

// TypeORM's real Repository.create/save are heavily overloaded (single vs
// array args) — jest.Mocked<Pick<Repository<T>, ...>> can't satisfy every
// overload with one mock implementation, so this only models the one
// signature LedgerService actually calls.
interface FakeAccountRepo {
  create: jest.Mock<Account, [Partial<Account>]>;
  save: jest.Mock<Promise<Account>, [Account]>;
}

describe('LedgerService', () => {
  let service: LedgerService;
  let repo: FakeAccountRepo;
  let manager: { getRepository: jest.Mock<FakeAccountRepo, unknown[]> };

  beforeEach(() => {
    service = new LedgerService();
    repo = {
      create: jest.fn((data: Partial<Account>) => data as Account),
      save: jest.fn((entity: Account) =>
        Promise.resolve({ ...entity, id: 'wallet-1' }),
      ),
    };
    manager = {
      getRepository: jest.fn(() => repo),
    };
  });

  it('creates a zero-balance user_wallet liability account in the caller-supplied currency', async () => {
    const wallet = await service.createUserWallet(
      manager as unknown as EntityManager,
      'user-1',
      'NGN',
    );

    expect(repo.create).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'liability',
      role: 'user_wallet',
      provider: null,
      currency: 'NGN',
      balance: 0n,
    });
    expect(repo.save).toHaveBeenCalled();
    expect(wallet).toMatchObject({
      userId: 'user-1',
      currency: 'NGN',
      balance: 0n,
      role: 'user_wallet',
      type: 'liability',
    });
  });

  it('uses the manager passed in, not any ambient repository', async () => {
    await service.createUserWallet(
      manager as unknown as EntityManager,
      'user-2',
      'NGN',
    );

    expect(manager.getRepository).toHaveBeenCalledWith(Account);
  });
});
