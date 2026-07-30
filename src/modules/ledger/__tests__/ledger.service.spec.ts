import { DataSource, EntityManager } from 'typeorm';
import { LedgerService } from '../ledger.service';
import { Account } from '../entities/account.entity';
import { Money } from '../../../shared/primitives/money';
import { Transaction } from '../entities/transaction.entity';

// TypeORM's real Repository.create/save are heavily overloaded (single vs
// array args) — jest.Mocked<Pick<Repository<T>, ...>> can't satisfy every
// overload with one mock implementation, so this only models the one
// signature LedgerService actually calls.
interface FakeAccountRepo {
  create: jest.Mock<Account, [Partial<Account>]>;
  save: jest.Mock<Promise<Account>, [Account]>;
  findOneByOrFail: jest.Mock<Promise<Account>, [Partial<Account>]>;
}

interface FakeTransactionRepo {
  create: jest.Mock<Transaction, [Partial<Transaction>]>;
  save: jest.Mock<Promise<Transaction>, [Transaction]>;
  findOneBy: jest.Mock<Promise<Transaction | null>, [Partial<Transaction>]>;
  update: jest.Mock<
    Promise<unknown>,
    [Partial<Transaction>, Partial<Transaction>]
  >;
}

describe('LedgerService', () => {
  let service: LedgerService;
  let repo: FakeAccountRepo;
  let manager: { getRepository: jest.Mock<FakeAccountRepo, unknown[]> };

  beforeEach(() => {
    repo = {
      create: jest.fn((data: Partial<Account>) => data as Account),
      save: jest.fn((entity: Account) =>
        Promise.resolve({ ...entity, id: 'wallet-1' }),
      ),
      findOneByOrFail: jest.fn<Promise<Account>, [Partial<Account>]>(),
    };
    manager = {
      getRepository: jest.fn(() => repo),
    };
    const dataSource = {
      getRepository: jest.fn(() => repo),
    } as unknown as DataSource;
    service = new LedgerService(dataSource);
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

  it("looks up a user's wallet by user_wallet role", async () => {
    const account = {
      id: 'wallet-1',
      userId: 'user-1',
      role: 'user_wallet',
      currency: 'NGN',
      balance: 500n,
    } as Account;
    repo.findOneByOrFail.mockResolvedValue(account);

    const wallet = await service.getUserWallet('user-1');

    expect(repo.findOneByOrFail).toHaveBeenCalledWith({
      userId: 'user-1',
      role: 'user_wallet',
    });
    expect(wallet).toBe(account);
  });

  describe('funding transactions', () => {
    let transactionRepo: FakeTransactionRepo;

    beforeEach(() => {
      transactionRepo = {
        create: jest.fn((data: Partial<Transaction>) => data as Transaction),
        save: jest.fn((entity: Transaction) =>
          Promise.resolve({ ...entity, id: 'txn-1' }),
        ),
        findOneBy: jest.fn<
          Promise<Transaction | null>,
          [Partial<Transaction>]
        >(),
        update: jest
          .fn<Promise<unknown>, [Partial<Transaction>, Partial<Transaction>]>()
          .mockResolvedValue(undefined),
      };
      const dataSource = {
        getRepository: jest.fn((entity: unknown) =>
          entity === Transaction ? transactionRepo : repo,
        ),
      } as unknown as DataSource;
      service = new LedgerService(dataSource);
    });

    it('looks up a transaction by its reference', async () => {
      const transaction = { id: 'txn-1', reference: 'ref-1' } as Transaction;
      transactionRepo.findOneBy.mockResolvedValue(transaction);

      const found = await service.findTransactionByReference('ref-1');

      expect(transactionRepo.findOneBy).toHaveBeenCalledWith({
        reference: 'ref-1',
      });
      expect(found).toBe(transaction);
    });

    it('returns null when no transaction matches the reference', async () => {
      transactionRepo.findOneBy.mockResolvedValue(null);

      const found = await service.findTransactionByReference('missing-ref');

      expect(found).toBeNull();
    });

    it('creates a pending funding transaction with provider_reference mirroring reference', async () => {
      const transaction = await service.createPendingFundingTransaction({
        reference: 'cliqpay-ref-1',
        provider: 'kora',
        providerReference: 'cliqpay-ref-1',
        amount: Money.of(500000n, 'NGN'),
        recipientWalletId: 'wallet-1',
        metadata: { checkoutUrl: 'https://example.com/pay' },
      });

      expect(transactionRepo.create).toHaveBeenCalledWith({
        reference: 'cliqpay-ref-1',
        provider: 'kora',
        providerReference: 'cliqpay-ref-1',
        type: 'funding',
        status: 'pending',
        reversesTransactionId: null,
        amount: 500000n,
        currency: 'NGN',
        senderWalletId: null,
        recipientWalletId: 'wallet-1',
        metadata: { checkoutUrl: 'https://example.com/pay' },
      });
      expect(transactionRepo.save).toHaveBeenCalled();
      expect(transaction).toMatchObject({
        type: 'funding',
        status: 'pending',
        amount: 500000n,
      });
    });

    it('sets the checkout URL on the transaction matching the reference', async () => {
      await service.setFundingCheckoutUrl(
        'cliqpay-ref-1',
        'https://checkout.korapay.com/abc',
      );

      expect(transactionRepo.update).toHaveBeenCalledWith(
        { reference: 'cliqpay-ref-1' },
        { metadata: { checkoutUrl: 'https://checkout.korapay.com/abc' } },
      );
    });

    it('marks the transaction matching the reference as failed', async () => {
      await service.markFundingTransactionFailed('cliqpay-ref-1');

      expect(transactionRepo.update).toHaveBeenCalledWith(
        { reference: 'cliqpay-ref-1' },
        { status: 'failed' },
      );
    });
  });
});
