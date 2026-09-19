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
  ChargebackAmountExceedsRemainingException,
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
  let ledgerService: jest.Mocked<
    Pick<
      LedgerService,
      | 'findFundingTransactionForChargeback'
      | 'getChargedBackAmount'
      | 'postChargeback'
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
    ledgerService = {
      findFundingTransactionForChargeback: jest
        .fn()
        .mockResolvedValue(originalTransaction),
      getChargedBackAmount: jest.fn().mockResolvedValue(Money.zero('NGN')),
      postChargeback: jest
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
      disputeRepo as never,
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
      expect(ledgerService.postChargeback).not.toHaveBeenCalled();
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

      expect(ledgerService.postChargeback).toHaveBeenCalled();
    });
  });

  describe('amount cap', () => {
    it('rejects an amount exceeding original_net_amount minus prior chargebacks', async () => {
      ledgerService.getChargedBackAmount.mockResolvedValue(
        Money.of(400_000n, 'NGN'),
      );

      // original 500_000 - already charged back 400_000 = 100_000 remaining;
      // requesting 200_000 exceeds it.
      await expect(service.recordChargeback(dto())).rejects.toThrow(
        ChargebackAmountExceedsRemainingException,
      );
      expect(ledgerService.postChargeback).not.toHaveBeenCalled();
    });

    it('allows an amount exactly equal to the remaining chargebackable balance', async () => {
      ledgerService.getChargedBackAmount.mockResolvedValue(
        Money.of(300_000n, 'NGN'),
      );

      // 500_000 - 300_000 = 200_000 remaining, requesting exactly 200_000.
      await service.recordChargeback(dto({ amount: 200_000 }));

      expect(ledgerService.postChargeback).toHaveBeenCalledWith(
        expect.objectContaining({ amount: Money.of(200_000n, 'NGN') }),
      );
    });
  });

  describe('freeze threshold', () => {
    it('freezes the account when the resulting balance is strictly negative', async () => {
      ledgerService.postChargeback.mockResolvedValue(
        postedResult(Money.of(-1n, 'NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).toHaveBeenCalledWith('user-1');
      expect(result.accountFrozen).toBe(true);
    });

    it('does not freeze when the chargeback exactly zeroes the balance', async () => {
      ledgerService.postChargeback.mockResolvedValue(
        postedResult(Money.zero('NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).not.toHaveBeenCalled();
      expect(result.accountFrozen).toBe(false);
    });

    it('does not freeze when the balance stays positive', async () => {
      ledgerService.postChargeback.mockResolvedValue(
        postedResult(Money.of(100_000n, 'NGN')),
      );

      const result = await service.recordChargeback(dto());

      expect(usersService.freeze).not.toHaveBeenCalled();
      expect(result.accountFrozen).toBe(false);
    });
  });

  describe('events', () => {
    it('always publishes chargeback_received', async () => {
      ledgerService.postChargeback.mockResolvedValue(
        postedResult(Money.of(100_000n, 'NGN')),
      );

      await service.recordChargeback(dto());

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'chargeback_received' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('publishes account_frozen only when a freeze actually happens', async () => {
      ledgerService.postChargeback.mockResolvedValue(
        postedResult(Money.of(-1n, 'NGN')),
      );

      await service.recordChargeback(dto());

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'account_frozen' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(2);
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
