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
  count: jest.Mock<Promise<number>, [unknown]>;
}

interface FakeTransactionRepo {
  create: jest.Mock<Transaction, [Partial<Transaction>]>;
  save: jest.Mock<Promise<Transaction>, [Transaction]>;
  findOneBy: jest.Mock<Promise<Transaction | null>, [Partial<Transaction>]>;
  update: jest.Mock<
    Promise<unknown>,
    [Partial<Transaction>, Partial<Transaction>]
  >;
  find: jest.Mock<Promise<Transaction[]>, [unknown]>;
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
      count: jest.fn<Promise<number>, [unknown]>(),
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
    let queryBuilder: {
      update: jest.Mock;
      set: jest.Mock<unknown, [{ metadata: () => string }]>;
      where: jest.Mock;
      setParameter: jest.Mock;
      execute: jest.Mock;
    };

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
        find: jest
          .fn<Promise<Transaction[]>, [unknown]>()
          .mockResolvedValue([]),
      };
      // Chained builder for LedgerService's private mergeTransactionMetadata
      // (setFundingCheckoutUrl's real implementation) — a real jsonb `||`
      // merge, not a plain repo.update(), so it goes through
      // dataSource.createQueryBuilder() instead.
      queryBuilder = {
        update: jest.fn(),
        set: jest.fn<unknown, [{ metadata: () => string }]>(),
        where: jest.fn(),
        setParameter: jest.fn(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      queryBuilder.update.mockReturnValue(queryBuilder);
      queryBuilder.set.mockReturnValue(queryBuilder);
      queryBuilder.where.mockReturnValue(queryBuilder);
      queryBuilder.setParameter.mockReturnValue(queryBuilder);
      const dataSource = {
        getRepository: jest.fn((entity: unknown) =>
          entity === Transaction ? transactionRepo : repo,
        ),
        createQueryBuilder: jest.fn(() => queryBuilder),
      } as unknown as DataSource;
      service = new LedgerService(dataSource);
    });

    describe('checkIdempotentReplay', () => {
      it("returns 'none' when no transaction matches the reference", async () => {
        transactionRepo.findOneBy.mockResolvedValue(null);

        const result = await service.checkIdempotentReplay(
          'missing-ref',
          'user-1',
          { amount: 500000n, currency: 'NGN' },
        );

        expect(transactionRepo.findOneBy).toHaveBeenCalledWith({
          reference: 'missing-ref',
        });
        expect(result).toEqual({ outcome: 'none' });
        expect(repo.count).not.toHaveBeenCalled();
      });

      it("returns 'foreign' when the reference belongs to a different user, without exposing the transaction", async () => {
        const transaction = {
          id: 'txn-1',
          reference: 'ref-1',
          amount: 500000n,
          currency: 'NGN',
          senderWalletId: null,
          recipientWalletId: 'wallet-owned-by-someone-else',
        } as Transaction;
        transactionRepo.findOneBy.mockResolvedValue(transaction);
        repo.count.mockResolvedValue(0);

        const result = await service.checkIdempotentReplay('ref-1', 'user-1', {
          amount: 500000n,
          currency: 'NGN',
        });

        expect(result).toEqual({ outcome: 'foreign' });
      });

      it("returns 'match' with the transaction when the reference belongs to the caller and the fingerprint matches", async () => {
        const transaction = {
          id: 'txn-1',
          reference: 'ref-1',
          amount: 500000n,
          currency: 'NGN',
          senderWalletId: null,
          recipientWalletId: 'wallet-1',
        } as Transaction;
        transactionRepo.findOneBy.mockResolvedValue(transaction);
        repo.count.mockResolvedValue(1);

        const result = await service.checkIdempotentReplay('ref-1', 'user-1', {
          amount: 500000n,
          currency: 'NGN',
        });

        expect(result).toEqual({ outcome: 'match', transaction });
      });

      it("returns 'diverged' when the caller owns the reference but the amount differs from what produced it", async () => {
        const transaction = {
          id: 'txn-1',
          reference: 'ref-1',
          amount: 500000n,
          currency: 'NGN',
          senderWalletId: null,
          recipientWalletId: 'wallet-1',
        } as Transaction;
        transactionRepo.findOneBy.mockResolvedValue(transaction);
        repo.count.mockResolvedValue(1);

        const result = await service.checkIdempotentReplay('ref-1', 'user-1', {
          amount: 999n,
          currency: 'NGN',
        });

        expect(result).toEqual({ outcome: 'diverged' });
      });

      it('checks the counterparty wallet only when the caller supplies one in the fingerprint', async () => {
        const transaction = {
          id: 'txn-1',
          reference: 'ref-1',
          amount: 500000n,
          currency: 'NGN',
          senderWalletId: 'wallet-1',
          recipientWalletId: 'wallet-recipient',
        } as Transaction;
        transactionRepo.findOneBy.mockResolvedValue(transaction);
        repo.count.mockResolvedValue(1);

        const result = await service.checkIdempotentReplay('ref-1', 'user-1', {
          amount: 500000n,
          currency: 'NGN',
          counterpartyWalletId: 'a-different-recipient',
        });

        expect(result).toEqual({ outcome: 'diverged' });
      });
    });

    it('creates a pending funding transaction with provider_reference mirroring reference', async () => {
      const transaction = await service.createPendingFundingTransaction({
        reference: 'cliqpay-ref-1',
        provider: 'kora',
        providerReference: 'cliqpay-ref-1',
        amount: Money.of(500000n, 'NGN'),
        recipientWalletId: 'wallet-1',
        metadata: { checkoutUrl: 'https://example.com/pay', grossAmount: null },
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
        metadata: { checkoutUrl: 'https://example.com/pay', grossAmount: null },
      });
      expect(transactionRepo.save).toHaveBeenCalled();
      expect(transaction).toMatchObject({
        type: 'funding',
        status: 'pending',
        amount: 500000n,
      });
    });

    it('sets the checkout URL on the transaction matching the reference via a jsonb merge, not an overwrite', async () => {
      await service.setFundingCheckoutUrl(
        'cliqpay-ref-1',
        'https://checkout.korapay.com/abc',
      );

      expect(queryBuilder.update).toHaveBeenCalledWith(Transaction);
      expect(queryBuilder.set).toHaveBeenCalledWith({
        metadata: expect.any(Function) as unknown,
      });
      const setArg = queryBuilder.set.mock.calls[0][0];
      expect(setArg.metadata()).toBe('metadata || :patch::jsonb');
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'reference = :reference',
        { reference: 'cliqpay-ref-1' },
      );
      expect(queryBuilder.setParameter).toHaveBeenCalledWith(
        'patch',
        JSON.stringify({ checkoutUrl: 'https://checkout.korapay.com/abc' }),
      );
      expect(queryBuilder.execute).toHaveBeenCalled();
    });

    it('marks the transaction matching the reference as failed', async () => {
      await service.markFundingTransactionFailed('cliqpay-ref-1');

      expect(transactionRepo.update).toHaveBeenCalledWith(
        { reference: 'cliqpay-ref-1' },
        { status: 'failed' },
      );
    });

    it('finds stale pending kora funding transactions older than the given date, narrowed to reference/currency', async () => {
      const olderThan = new Date('2026-01-01T00:00:00Z');
      transactionRepo.find.mockResolvedValue([
        {
          reference: 'cliqpay-ref-1',
          currency: 'NGN',
          status: 'pending',
        } as Transaction,
      ]);

      const stale = await service.findStaleFundingTransactions(olderThan);

      expect(transactionRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'pending',
            provider: 'kora',
            type: 'funding',
          }) as unknown,
          select: { reference: true, currency: true },
        }),
      );
      expect(stale).toEqual([{ reference: 'cliqpay-ref-1', currency: 'NGN' }]);
    });
  });
});
