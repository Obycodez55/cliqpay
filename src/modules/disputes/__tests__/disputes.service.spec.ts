import { DataSource, EntityManager } from 'typeorm';
import { DisputesService } from '../disputes.service';
import {
  LedgerService,
  PostChargebackResolutionResult,
  PostChargebackResult,
  UpholdChargebackResult,
} from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import { Dispute } from '../entities/dispute.entity';
import {
  DisputeAlreadyResolvedException,
  DisputeNotFoundException,
  DisputeResolutionAmountMismatchException,
  DuplicateDisputeReferenceException,
  OriginalTransactionNotDisputableException,
  OriginalTransactionNotFoundException,
} from '../internal/errors';

type FakeQueryBuilder = {
  where: jest.Mock<FakeQueryBuilder, unknown[]>;
  setLock: jest.Mock<FakeQueryBuilder, unknown[]>;
  getOne: jest.Mock<Promise<Dispute | null>, unknown[]>;
};

type FakeDisputeRepo = {
  findOneBy: jest.Mock<Promise<Dispute | null>, [Partial<Dispute>]>;
  find: jest.Mock<Promise<Dispute[]>, [unknown]>;
  findOneByOrFail: jest.Mock<Promise<Dispute>, [Partial<Dispute>]>;
  create: jest.Mock<Dispute, [Partial<Dispute>]>;
  save: jest.Mock<Promise<Dispute>, [Dispute]>;
  update: jest.Mock<Promise<unknown>, [Partial<Dispute>, Partial<Dispute>]>;
  createQueryBuilder: jest.Mock<FakeQueryBuilder, [string]>;
};

describe('DisputesService', () => {
  let service: DisputesService;
  let disputeRepo: FakeDisputeRepo;
  let fakeManager: EntityManager;
  let dataSource: jest.Mocked<
    Pick<DataSource, 'getRepository' | 'transaction'>
  >;
  let ledgerService: jest.Mocked<
    Pick<
      LedgerService,
      | 'findFundingTransactionForChargeback'
      | 'postChargebackWithinTransaction'
      | 'findNegativeBalanceWallets'
      | 'findChargebackTransactionsForWallets'
      | 'upholdChargebackWithinTransaction'
      | 'postChargebackResolutionWithinTransaction'
    >
  >;
  let usersService: jest.Mocked<
    Pick<UsersService, 'freeze' | 'unfreeze' | 'findById' | 'findByIds'>
  >;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;

  const originalTransaction = {
    id: 'txn-original',
    status: 'completed' as const,
    amount: Money.of(500_000n, 'NGN'),
    recipientWalletId: 'wallet-1',
  };

  function postedResult(
    newWalletBalance: Money,
    amount = Money.of(200_000n, 'NGN'),
  ): PostChargebackResult {
    return {
      transactionId: 'txn-chargeback',
      reference: 'dispute-ref-1',
      reversesTransactionId: originalTransaction.id,
      userId: 'user-1',
      amount,
      newWalletBalance,
      createdAt: new Date('2026-09-18T00:00:00Z'),
    };
  }

  function resolutionResult(
    newWalletBalance: Money,
    amount = Money.of(200_000n, 'NGN'),
  ): PostChargebackResolutionResult {
    return {
      transactionId: 'txn-resolution',
      reference: 'dispute-ref-1-resolved',
      reversesTransactionId: 'txn-chargeback',
      userId: 'user-1',
      amount,
      newWalletBalance,
      createdAt: new Date('2026-09-19T00:00:00Z'),
    };
  }

  const openDispute: Dispute = {
    id: 'dispute-1',
    chargebackTransactionId: 'txn-chargeback',
    disputeReference: 'dispute-ref-1',
    status: 'open',
    amount: 200_000n,
    currency: 'NGN',
    resolvedAt: null,
    createdAt: new Date('2026-09-18T00:00:00Z'),
    updatedAt: new Date('2026-09-18T00:00:00Z'),
  };

  beforeEach(() => {
    disputeRepo = {
      findOneBy: jest
        .fn<Promise<Dispute | null>, [Partial<Dispute>]>()
        .mockResolvedValue(null),
      find: jest.fn<Promise<Dispute[]>, [unknown]>().mockResolvedValue([]),
      findOneByOrFail: jest
        .fn<Promise<Dispute>, [Partial<Dispute>]>()
        .mockImplementation(() => {
          throw new Error('findOneByOrFail not configured for this test');
        }),
      create: jest.fn((data: Partial<Dispute>) => data as Dispute),
      save: jest.fn((entity: Dispute) =>
        Promise.resolve({
          ...entity,
          id: 'dispute-1',
          createdAt: new Date('2026-09-18T00:00:00Z'),
          updatedAt: new Date('2026-09-18T00:00:00Z'),
        }),
      ),
      update: jest
        .fn<Promise<unknown>, [Partial<Dispute>, Partial<Dispute>]>()
        .mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest
        .fn<FakeQueryBuilder, [string]>()
        .mockImplementation(() => {
          const qb: FakeQueryBuilder = {
            where: jest.fn(() => qb),
            setLock: jest.fn(() => qb),
            getOne: jest
              .fn<Promise<Dispute | null>, unknown[]>()
              .mockResolvedValue(null),
          };
          return qb;
        }),
    };
    fakeManager = {
      getRepository: jest.fn(() => disputeRepo),
    } as unknown as EntityManager;
    dataSource = {
      getRepository: jest.fn(() => disputeRepo),
      // Runs the callback against the same fake manager every test uses —
      // real DataSource.transaction commits on resolve and rolls back on
      // rejection, but nothing here asserts commit/rollback directly;
      // that's covered by the integration spec, which hits a real Postgres.
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) =>
          cb(fakeManager),
      ),
    } as unknown as jest.Mocked<
      Pick<DataSource, 'getRepository' | 'transaction'>
    >;
    ledgerService = {
      findFundingTransactionForChargeback: jest
        .fn()
        .mockResolvedValue(originalTransaction),
      postChargebackWithinTransaction: jest
        .fn()
        .mockResolvedValue(postedResult(Money.of(300_000n, 'NGN'))),
      findNegativeBalanceWallets: jest.fn().mockResolvedValue([]),
      findChargebackTransactionsForWallets: jest.fn().mockResolvedValue([]),
      upholdChargebackWithinTransaction: jest
        .fn<Promise<UpholdChargebackResult>, [EntityManager, string]>()
        .mockResolvedValue({ originalTransactionId: 'txn-original' }),
      postChargebackResolutionWithinTransaction: jest
        .fn<
          Promise<PostChargebackResolutionResult>,
          [EntityManager, { chargebackTransactionId: string; amount: Money }]
        >()
        .mockResolvedValue(resolutionResult(Money.of(0n, 'NGN'))),
    };
    usersService = {
      freeze: jest.fn().mockResolvedValue(undefined),
      unfreeze: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({ email: 'user@example.com' }),
      findByIds: jest.fn().mockResolvedValue([]),
    };
    eventBus = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    service = new DisputesService(
      dataSource as unknown as DataSource,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      eventBus as unknown as EventBusService,
    );
  });

  function dto(
    overrides: Partial<{ amount: number; disputeReference: string }> = {},
  ) {
    return {
      originalTransactionReference: 'cliqpay-fund-1',
      amount: overrides.amount ?? 200_000,
      disputeReference: overrides.disputeReference ?? 'dispute-ref-1',
    };
  }

  describe('dedupe', () => {
    it('rejects a repeat dispute_reference before doing any posting work', async () => {
      disputeRepo.findOneBy.mockResolvedValue({ id: 'existing' } as Dispute);

      await expect(service.recordChargeback(dto())).rejects.toThrow(
        DuplicateDisputeReferenceException,
      );
      expect(
        ledgerService.postChargebackWithinTransaction,
      ).not.toHaveBeenCalled();
    });

    it('maps a unique-violation on the chargeback transaction reference to the same duplicate error', async () => {
      const violation = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'UQ_transactions_reference',
      });
      ledgerService.postChargebackWithinTransaction.mockRejectedValue(
        violation,
      );

      await expect(service.recordChargeback(dto())).rejects.toThrow(
        DuplicateDisputeReferenceException,
      );
    });
  });

  describe('original transaction validation', () => {
    it('rejects when no funding transaction matches the reference', async () => {
      ledgerService.findFundingTransactionForChargeback.mockResolvedValue(null);

      await expect(service.recordChargeback(dto())).rejects.toThrow(
        OriginalTransactionNotFoundException,
      );
    });

    it.each(['pending', 'failed', 'reversed'] as const)(
      'rejects a %s original transaction as not chargebackable',
      async (status) => {
        ledgerService.findFundingTransactionForChargeback.mockResolvedValue({
          ...originalTransaction,
          status,
        });

        await expect(service.recordChargeback(dto())).rejects.toThrow(
          OriginalTransactionNotDisputableException,
        );
      },
    );

    it('allows a further partial chargeback against an already-disputed original', async () => {
      ledgerService.findFundingTransactionForChargeback.mockResolvedValue({
        ...originalTransaction,
        status: 'disputed',
      });

      await service.recordChargeback(dto());

      expect(ledgerService.postChargebackWithinTransaction).toHaveBeenCalled();
    });
  });

  // The amount-cap check itself (original amount minus prior chargebacks)
  // is no longer this service's concern — it's enforced inside
  // LedgerService.postChargeback, under the lock it holds on the original
  // transaction row, precisely so two concurrent partial chargebacks can't
  // both read a stale "remaining" figure (see that method's own tests and
  // the disputes-record-chargeback integration spec's concurrency case).

  describe('atomicity', () => {
    it('posts, freezes, and writes the dispute row inside one transaction', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.of(-1n, 'NGN')),
      );

      await service.recordChargeback(dto());

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(
        ledgerService.postChargebackWithinTransaction,
      ).toHaveBeenCalledWith(fakeManager, expect.anything());
      expect(usersService.freeze).toHaveBeenCalledWith(fakeManager, 'user-1');
    });

    it('lets a failure inside the transaction propagate without writing a dispute row', async () => {
      ledgerService.postChargebackWithinTransaction.mockRejectedValue(
        new Error('posting failed'),
      );

      await expect(service.recordChargeback(dto())).rejects.toThrow(
        'posting failed',
      );
      expect(disputeRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('freeze threshold', () => {
    it('freezes the account when the resulting balance is strictly negative', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.of(-1n, 'NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).toHaveBeenCalledWith(fakeManager, 'user-1');
      expect(result.accountFrozen).toBe(true);
    });

    it('does not freeze when the chargeback exactly zeroes the balance', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.zero('NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).not.toHaveBeenCalled();
      expect(result.accountFrozen).toBe(false);
    });

    it('does not freeze when the balance stays positive', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.of(100_000n, 'NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).not.toHaveBeenCalled();
      expect(result.accountFrozen).toBe(false);
    });
  });

  describe('events', () => {
    it('always publishes chargeback_received', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.of(100_000n, 'NGN')),
      );

      await service.recordChargeback(dto());

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'chargeback_received' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('publishes account_frozen only when a freeze actually happens', async () => {
      ledgerService.postChargebackWithinTransaction.mockResolvedValue(
        postedResult(Money.of(-1n, 'NGN')),
      );

      await service.recordChargeback(dto());

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'account_frozen' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(2);
    });

    it('does not publish, but still returns the result, when fetching the email fails', async () => {
      usersService.findById.mockRejectedValue(new Error('db blip'));

      const result = await service.recordChargeback(dto());

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(result.disputeReference).toBe('dispute-ref-1');
    });
  });

  describe('dispute row', () => {
    it('creates the dispute row as open, priced at the requested amount', async () => {
      await service.recordChargeback(dto({ amount: 200_000 }));

      expect(disputeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          chargebackTransactionId: 'txn-chargeback',
          disputeReference: 'dispute-ref-1',
          status: 'open',
          amount: 200_000n,
          currency: 'NGN',
          resolvedAt: null,
        }),
      );
    });
  });

  describe('getCollections (issue #37)', () => {
    it('returns an empty list without querying chargebacks/users when no wallet is negative', async () => {
      ledgerService.findNegativeBalanceWallets.mockResolvedValue([]);

      const result = await service.getCollections();

      expect(result).toEqual([]);
      expect(
        ledgerService.findChargebackTransactionsForWallets,
      ).not.toHaveBeenCalled();
      expect(usersService.findByIds).not.toHaveBeenCalled();
    });

    it('composes a negative-balance wallet with its chargeback, dispute row, and frozen status', async () => {
      ledgerService.findNegativeBalanceWallets.mockResolvedValue([
        {
          accountId: 'wallet-1',
          userId: 'user-1',
          balance: Money.of(-50_000n, 'NGN'),
        },
      ]);
      ledgerService.findChargebackTransactionsForWallets.mockResolvedValue([
        {
          transactionId: 'chargeback-txn-1',
          walletId: 'wallet-1',
          amount: Money.of(150_000n, 'NGN'),
          createdAt: new Date('2026-09-18T00:00:00Z'),
        },
      ]);
      disputeRepo.find.mockResolvedValue([
        {
          id: 'dispute-1',
          chargebackTransactionId: 'chargeback-txn-1',
          disputeReference: 'dispute-ref-1',
          status: 'open',
          amount: 150_000n,
          currency: 'NGN',
          resolvedAt: null,
          createdAt: new Date('2026-09-18T00:00:00Z'),
          updatedAt: new Date('2026-09-18T00:00:00Z'),
        },
      ]);
      usersService.findByIds.mockResolvedValue([
        { id: 'user-1', isFrozen: true } as never,
      ]);

      const result = await service.getCollections();

      expect(
        ledgerService.findChargebackTransactionsForWallets,
      ).toHaveBeenCalledWith(['wallet-1']);
      expect(usersService.findByIds).toHaveBeenCalledWith(['user-1']);
      expect(result).toEqual([
        {
          userId: 'user-1',
          balance: { amount: '-50000', currency: 'NGN' },
          isFrozen: true,
          chargebacks: [
            {
              chargebackTransactionId: 'chargeback-txn-1',
              amount: { amount: '150000', currency: 'NGN' },
              disputeReference: 'dispute-ref-1',
              disputeStatus: 'open',
            },
          ],
        },
      ]);
    });

    it('lists every chargeback contributing to a wallet, not just the most recent', async () => {
      ledgerService.findNegativeBalanceWallets.mockResolvedValue([
        {
          accountId: 'wallet-1',
          userId: 'user-1',
          balance: Money.of(-10_000n, 'NGN'),
        },
      ]);
      ledgerService.findChargebackTransactionsForWallets.mockResolvedValue([
        {
          transactionId: 'chargeback-txn-1',
          walletId: 'wallet-1',
          amount: Money.of(100_000n, 'NGN'),
          createdAt: new Date('2026-09-01T00:00:00Z'),
        },
        {
          transactionId: 'chargeback-txn-2',
          walletId: 'wallet-1',
          amount: Money.of(50_000n, 'NGN'),
          createdAt: new Date('2026-09-18T00:00:00Z'),
        },
      ]);
      disputeRepo.find.mockResolvedValue([
        {
          chargebackTransactionId: 'chargeback-txn-1',
          disputeReference: 'dispute-ref-1',
          status: 'resolved',
        } as Dispute,
        {
          chargebackTransactionId: 'chargeback-txn-2',
          disputeReference: 'dispute-ref-2',
          status: 'open',
        } as Dispute,
      ]);
      usersService.findByIds.mockResolvedValue([
        { id: 'user-1', isFrozen: true } as never,
      ]);

      const result = await service.getCollections();

      expect(result[0].chargebacks).toHaveLength(2);
      expect(result[0].chargebacks.map((c) => c.disputeReference)).toEqual([
        'dispute-ref-1',
        'dispute-ref-2',
      ]);
    });

    it('treats a user not returned by findByIds as not frozen rather than throwing', async () => {
      ledgerService.findNegativeBalanceWallets.mockResolvedValue([
        {
          accountId: 'wallet-1',
          userId: 'user-1',
          balance: Money.of(-10_000n, 'NGN'),
        },
      ]);
      usersService.findByIds.mockResolvedValue([]);

      const result = await service.getCollections();

      expect(result[0].isFrozen).toBe(false);
    });

    it('throws if a chargeback transaction has no matching dispute row', async () => {
      ledgerService.findNegativeBalanceWallets.mockResolvedValue([
        {
          accountId: 'wallet-1',
          userId: 'user-1',
          balance: Money.of(-10_000n, 'NGN'),
        },
      ]);
      ledgerService.findChargebackTransactionsForWallets.mockResolvedValue([
        {
          transactionId: 'chargeback-txn-1',
          walletId: 'wallet-1',
          amount: Money.of(100_000n, 'NGN'),
          createdAt: new Date('2026-09-01T00:00:00Z'),
        },
      ]);
      disputeRepo.find.mockResolvedValue([]);
      usersService.findByIds.mockResolvedValue([
        { id: 'user-1', isFrozen: false } as never,
      ]);

      await expect(service.getCollections()).rejects.toThrow(
        /no dispute row found/,
      );
    });
  });

  describe('resolveDispute', () => {
    // The fake `disputes` row this describe block's queries and mutations
    // operate against — stands in for the row a real `pessimistic_write`
    // lock would read/update inside one Postgres transaction. `null` models
    // no matching dispute_reference.
    let currentDispute: Dispute | null;

    function resolveDto(
      overrides: Partial<{
        disputeReference: string;
        outcome: 'upheld' | 'resolved';
        amount: number;
      }> = {},
    ) {
      return {
        disputeReference: overrides.disputeReference ?? 'dispute-ref-1',
        outcome: overrides.outcome ?? 'upheld',
        amount: overrides.amount,
      };
    }

    beforeEach(() => {
      currentDispute = { ...openDispute };

      disputeRepo.createQueryBuilder.mockImplementation(() => {
        const qb: FakeQueryBuilder = {
          where: jest.fn(() => qb),
          setLock: jest.fn(() => qb),
          getOne: jest
            .fn<Promise<Dispute | null>, unknown[]>()
            .mockResolvedValue(currentDispute),
        };
        return qb;
      });
      disputeRepo.update.mockImplementation((_criteria, patch) => {
        if (currentDispute) {
          currentDispute = { ...currentDispute, ...patch };
        }
        return Promise.resolve({ affected: 1 });
      });
      disputeRepo.findOneByOrFail.mockImplementation(() =>
        Promise.resolve(currentDispute as Dispute),
      );
    });

    describe('validation', () => {
      it('rejects an unknown dispute_reference', async () => {
        currentDispute = null;

        await expect(service.resolveDispute(resolveDto())).rejects.toThrow(
          DisputeNotFoundException,
        );
      });

      it.each(['resolved', 'upheld'] as const)(
        'rejects a dispute that is already %s',
        async (status) => {
          currentDispute!.status = status;

          await expect(service.resolveDispute(resolveDto())).rejects.toThrow(
            DisputeAlreadyResolvedException,
          );
        },
      );

      it("rejects a resolved outcome whose amount doesn't match the dispute's own recorded amount", async () => {
        await expect(
          service.resolveDispute(
            resolveDto({ outcome: 'resolved', amount: 100_000 }),
          ),
        ).rejects.toThrow(DisputeResolutionAmountMismatchException);
        expect(
          ledgerService.postChargebackResolutionWithinTransaction,
        ).not.toHaveBeenCalled();
      });
    });

    describe('upheld', () => {
      it('flips the dispute to upheld and touches neither the ledger reversal nor the freeze', async () => {
        const result = await service.resolveDispute(
          resolveDto({ outcome: 'upheld' }),
        );

        expect(
          ledgerService.upholdChargebackWithinTransaction,
        ).toHaveBeenCalledWith(fakeManager, 'txn-chargeback');
        expect(
          ledgerService.postChargebackResolutionWithinTransaction,
        ).not.toHaveBeenCalled();
        expect(usersService.unfreeze).not.toHaveBeenCalled();
        expect(result.status).toBe('upheld');
        expect(result.accountUnfrozen).toBe(false);
      });
    });

    describe('resolved', () => {
      it('posts the reverse compensating transaction and unfreezes once the balance is non-negative', async () => {
        ledgerService.postChargebackResolutionWithinTransaction.mockResolvedValue(
          resolutionResult(Money.of(50_000n, 'NGN')),
        );

        const result = await service.resolveDispute(
          resolveDto({ outcome: 'resolved', amount: 200_000 }),
        );

        expect(
          ledgerService.postChargebackResolutionWithinTransaction,
        ).toHaveBeenCalledWith(fakeManager, {
          chargebackTransactionId: 'txn-chargeback',
          amount: Money.of(200_000n, 'NGN'),
        });
        expect(usersService.unfreeze).toHaveBeenCalledWith(
          fakeManager,
          'user-1',
        );
        expect(result.status).toBe('resolved');
        expect(result.accountUnfrozen).toBe(true);
      });

      it('unfreezes when the resolution brings the balance to exactly zero', async () => {
        ledgerService.postChargebackResolutionWithinTransaction.mockResolvedValue(
          resolutionResult(Money.zero('NGN')),
        );

        const result = await service.resolveDispute(
          resolveDto({ outcome: 'resolved', amount: 200_000 }),
        );

        expect(usersService.unfreeze).toHaveBeenCalled();
        expect(result.accountUnfrozen).toBe(true);
      });

      it('does not unfreeze when the resulting balance is still negative', async () => {
        ledgerService.postChargebackResolutionWithinTransaction.mockResolvedValue(
          resolutionResult(Money.of(-50_000n, 'NGN')),
        );

        const result = await service.resolveDispute(
          resolveDto({ outcome: 'resolved', amount: 200_000 }),
        );

        expect(usersService.unfreeze).not.toHaveBeenCalled();
        expect(result.accountUnfrozen).toBe(false);
      });
    });

    describe('atomicity', () => {
      it('propagates a ledger posting failure without writing the dispute row', async () => {
        ledgerService.postChargebackResolutionWithinTransaction.mockRejectedValue(
          new Error('posting failed'),
        );

        await expect(
          service.resolveDispute(
            resolveDto({ outcome: 'resolved', amount: 200_000 }),
          ),
        ).rejects.toThrow('posting failed');
        expect(disputeRepo.update).not.toHaveBeenCalled();
      });

      it('propagates a failure from the upheld ledger call without writing the dispute row', async () => {
        ledgerService.upholdChargebackWithinTransaction.mockRejectedValue(
          new Error('lock failed'),
        );

        await expect(
          service.resolveDispute(resolveDto({ outcome: 'upheld' })),
        ).rejects.toThrow('lock failed');
        expect(disputeRepo.update).not.toHaveBeenCalled();
      });
    });
  });
});
