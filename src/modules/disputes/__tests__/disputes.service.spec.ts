import { DataSource, EntityManager } from 'typeorm';
import { DisputesService } from '../disputes.service';
import {
  LedgerService,
  PostChargebackResult,
} from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import { Dispute } from '../entities/dispute.entity';
import {
  DuplicateDisputeReferenceException,
  OriginalTransactionNotDisputableException,
  OriginalTransactionNotFoundException,
} from '../internal/errors';

type FakeDisputeRepo = {
  findOneBy: jest.Mock<Promise<Dispute | null>, [Partial<Dispute>]>;
  create: jest.Mock<Dispute, [Partial<Dispute>]>;
  save: jest.Mock<Promise<Dispute>, [Dispute]>;
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
      'findFundingTransactionForChargeback' | 'postChargebackWithinTransaction'
    >
  >;
  let usersService: jest.Mocked<Pick<UsersService, 'freeze' | 'findById'>>;
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

  beforeEach(() => {
    disputeRepo = {
      findOneBy: jest
        .fn<Promise<Dispute | null>, [Partial<Dispute>]>()
        .mockResolvedValue(null),
      create: jest.fn((data: Partial<Dispute>) => data as Dispute),
      save: jest.fn((entity: Dispute) =>
        Promise.resolve({
          ...entity,
          id: 'dispute-1',
          createdAt: new Date('2026-09-18T00:00:00Z'),
          updatedAt: new Date('2026-09-18T00:00:00Z'),
        }),
      ),
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
    };
    usersService = {
      freeze: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({ email: 'user@example.com' }),
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
});
