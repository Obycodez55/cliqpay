import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../../config';
import { PaymentsService } from '../payments.service';
import {
  HoldFundingResult,
  LedgerService,
  PostFundingResult,
} from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { KycService } from '../../kyc/kyc.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import { PaymentProviderAdapter } from '../adapters/payment-provider.interface';
import { FakeAdapter } from '../adapters/fake.adapter';
import {
  FUNDING_COMPLETED_EVENT,
  REFUND_ATTENTION_REQUIRED_EVENT,
  FUNDING_HELD_EVENT,
  FUNDING_REFUNDED_EVENT,
  RECONCILIATION_MISMATCH_EVENT,
} from '../../../shared/events/domain-events';

function mockAdapter(): jest.Mocked<PaymentProviderAdapter> {
  return {
    initiatePayment: jest.fn(),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    verifyCharge: jest.fn(),
    getBalance: jest.fn(),
    resolveBankAccount: jest.fn(),
    initiatePayout: jest.fn(),
    verifyPayout: jest.fn(),
    initiateRefund: jest.fn(),
    verifyRefund: jest.fn(),
  };
}

const testConfig = {
  payments: { reconciliation: { alertEmail: 'ops@cliqpay.test' } },
} as AppConfig;

type CompletionLedger = jest.Mocked<
  Pick<
    LedgerService,
    | 'postFunding'
    | 'findPendingFundingOwner'
    | 'getWalletBalance'
    | 'postFundingWithinTransaction'
    | 'holdFundingWithinTransaction'
    | 'failRefund'
    | 'settleRefund'
    | 'findRefundContext'
    | 'findStalePendingRefunds'
    | 'findHeldFundings'
    | 'startRefundAttempt'
    | 'setRefundAlerts'
  >
>;

function completionLedger(): CompletionLedger {
  return {
    postFunding: jest.fn(),
    findPendingFundingOwner: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    getWalletBalance: jest.fn(),
    postFundingWithinTransaction: jest.fn(),
    holdFundingWithinTransaction: jest.fn(),
    failRefund: jest.fn(),
    settleRefund: jest.fn(),
    findRefundContext: jest.fn().mockResolvedValue(null),
    findStalePendingRefunds: jest.fn().mockResolvedValue([]),
    findHeldFundings: jest.fn().mockResolvedValue([]),
    startRefundAttempt: jest.fn(),
    setRefundAlerts: jest.fn(),
  };
}

function completionKyc() {
  return {
    checkIncomingCredit: jest.fn().mockResolvedValue({ allowed: true }),
  };
}

const heldResult: HoldFundingResult = {
  userId: 'user-1',
  netAmount: Money.of(500_000n, 'NGN'),
  fundingTransactionId: 'funding-1',
  fundingReference: 'cliqpay-ref-1',
  refundReference: 'rfd-funding-1-1',
};

const inlineTransaction = {
  transaction: jest.fn((work: (manager: unknown) => unknown) => work({})),
} as unknown as DataSource;

function webhookBody(overrides: Partial<Record<string, unknown>> = {}) {
  return Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        reference: 'cliqpay-ref-1',
        status: 'success',
        amount: '5000.00',
        fee: 50,
        ...overrides,
      },
    }),
    'utf8',
  );
}

describe('PaymentsService.handleKoraWebhook (charge events)', () => {
  let ledgerService: CompletionLedger;
  let kycService: ReturnType<typeof completionKyc>;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let adapter: jest.Mocked<PaymentProviderAdapter>;
  let service: PaymentsService;

  const postFundingResult: PostFundingResult = {
    userId: 'user-1',
    netAmount: Money.of(500_000n, 'NGN'),
    reference: 'cliqpay-ref-1',
  };

  beforeEach(() => {
    ledgerService = completionLedger();
    kycService = completionKyc();
    usersService = { findById: jest.fn() };
    eventBus = { publish: jest.fn() };
    adapter = mockAdapter();
    service = new PaymentsService(
      inlineTransaction,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      kycService as unknown as KycService,
      eventBus as unknown as EventBusService,
      adapter,
      testConfig,
    );
  });

  it('rejects an invalid signature before touching the ledger', async () => {
    adapter.verifyWebhookSignature.mockReturnValue(false);

    await expect(
      service.handleKoraWebhook(webhookBody(), 'bad-signature'),
    ).rejects.toThrow(UnauthorizedException);

    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('rejects a missing signature before touching the ledger', async () => {
    await expect(
      service.handleKoraWebhook(webhookBody(), undefined),
    ).rejects.toThrow(UnauthorizedException);

    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('checks the cap for the pending funding owner before crediting', async () => {
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.handleKoraWebhook(webhookBody(), 'sig');

    expect(kycService.checkIncomingCredit).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      Money.of(500_000n, 'NGN'),
      expect.any(Function),
    );
    expect(ledgerService.holdFundingWithinTransaction).not.toHaveBeenCalled();
  });

  describe('when the cap check refuses', () => {
    beforeEach(() => {
      kycService.checkIncomingCredit.mockResolvedValue({
        allowed: false,
        reason: 'over_cap',
        cap: Money.of(30_000_000n, 'NGN'),
        remaining: Money.zero('NGN'),
      });
      ledgerService.holdFundingWithinTransaction.mockResolvedValue(heldResult);
      usersService.findById.mockResolvedValue({
        email: 'user@example.com',
      } as Awaited<ReturnType<UsersService['findById']>>);
      adapter.initiateRefund.mockResolvedValue({ status: 'accepted' });
    });

    it('holds instead of crediting, and announces no completed funding', async () => {
      await service.handleKoraWebhook(webhookBody(), 'sig');

      expect(ledgerService.holdFundingWithinTransaction).toHaveBeenCalledWith(
        expect.anything(),
        {
          reference: 'cliqpay-ref-1',
          netAmount: Money.of(500_000n, 'NGN'),
          providerFee: Money.of(5_000n, 'NGN'),
          providerStatus: 'success',
        },
      );
      expect(ledgerService.postFundingWithinTransaction).not.toHaveBeenCalled();
      const names = eventBus.publish.mock.calls.map(
        (call) => (call[0] as { name: string }).name,
      );
      expect(names).toEqual([FUNDING_HELD_EVENT]);
    });

    it('publishes funding_held with the amount and the cap', async () => {
      await service.handleKoraWebhook(webhookBody(), 'sig');

      const published = eventBus.publish.mock.calls[0][0] as {
        payload: Record<string, unknown>;
      };
      expect(published.payload).toMatchObject({
        userId: 'user-1',
        email: 'user@example.com',
        amount: '5000.00',
        currency: 'NGN',
        reference: 'cliqpay-ref-1',
        cap: '300000.00',
      });
    });

    it('asks the provider to refund the held principal, against the funding reference', async () => {
      await service.handleKoraWebhook(webhookBody(), 'sig');

      expect(adapter.initiateRefund.mock.calls).toEqual([
        [
          {
            reference: 'rfd-funding-1-1',
            paymentReference: 'cliqpay-ref-1',
            amount: Money.of(500_000n, 'NGN'),
            reason: expect.any(String) as unknown,
          },
        ],
      ]);
    });

    it('starts the refund only after the transaction has committed', async () => {
      const order: string[] = [];
      (inlineTransaction.transaction as jest.Mock).mockImplementationOnce(
        async (work: (manager: unknown) => unknown) => {
          const result = await work({});
          order.push('commit');
          return result;
        },
      );
      adapter.initiateRefund.mockImplementation(() => {
        order.push('initiate');
        return Promise.resolve({ status: 'accepted' });
      });

      await service.handleKoraWebhook(webhookBody(), 'sig');

      expect(order).toEqual(['commit', 'initiate']);
    });

    it('fails the attempt when the provider rejects the refund', async () => {
      adapter.initiateRefund.mockResolvedValue({
        status: 'rejected',
        reason: 'Transaction not found',
      });

      await service.handleKoraWebhook(webhookBody(), 'sig');

      expect(ledgerService.failRefund).toHaveBeenCalledWith({
        refundReference: 'rfd-funding-1-1',
        reason: 'Transaction not found',
      });
    });

    it.each([
      [{ status: 'unknown', detail: 'timeout' } as const],
      [{ status: 'already_exists' } as const],
    ])('leaves the attempt pending on %o', async (result) => {
      adapter.initiateRefund.mockResolvedValue(result);

      await service.handleKoraWebhook(webhookBody(), 'sig');

      expect(ledgerService.failRefund).not.toHaveBeenCalled();
    });

    it('does not fail the webhook when the provider call throws', async () => {
      adapter.initiateRefund.mockRejectedValue(new Error('boom'));

      await expect(
        service.handleKoraWebhook(webhookBody(), 'sig'),
      ).resolves.toBeUndefined();
      expect(ledgerService.failRefund).not.toHaveBeenCalled();
    });

    it('still starts the refund when publishing the held notification fails', async () => {
      eventBus.publish.mockRejectedValue(new Error('redis unavailable'));

      await expect(
        service.handleKoraWebhook(webhookBody(), 'sig'),
      ).resolves.toBeUndefined();
      expect(adapter.initiateRefund.mock.calls).toHaveLength(1);
    });
  });

  it('falls back to postFunding without a cap check when no pending funding exists for the reference', async () => {
    ledgerService.findPendingFundingOwner.mockResolvedValue(null);
    ledgerService.postFunding.mockResolvedValue(null);

    await service.handleKoraWebhook(webhookBody(), 'sig');

    expect(ledgerService.postFunding).toHaveBeenCalledTimes(1);
    expect(kycService.checkIncomingCredit).not.toHaveBeenCalled();
  });

  it('records a provider-reported failure through postFunding without a cap check', async () => {
    ledgerService.postFunding.mockResolvedValue(null);

    await service.handleKoraWebhook(webhookBody({ status: 'failed' }), 'sig');

    expect(ledgerService.postFunding).toHaveBeenCalledTimes(1);
    expect(kycService.checkIncomingCredit).not.toHaveBeenCalled();
  });

  it('publishes funding_completed after a successful posting', async () => {
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.handleKoraWebhook(webhookBody(), 'sig');

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const published = eventBus.publish.mock.calls[0][0] as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(published.name).toBe(FUNDING_COMPLETED_EVENT);
    expect(published.payload).toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      amount: '5000.00',
      currency: 'NGN',
      reference: 'cliqpay-ref-1',
    });
  });

  it('does not publish when the posting reports a duplicate delivery', async () => {
    ledgerService.postFundingWithinTransaction.mockResolvedValue(null);

    await service.handleKoraWebhook(webhookBody(), 'sig');

    expect(usersService.findById).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // The regression this guards: a failure here used to propagate as a
  // thrown error, which would make the webhook handler return non-2xx,
  // which would make Kora retry — landing on postFunding's idempotency
  // guard (already `completed`) before ever reaching this code again,
  // permanently and silently dropping the notification despite the money
  // having posted correctly. See payments.service.ts's processFundingWebhookData.
  it('does not throw when publishing the completion notification fails, since the funding already posted', async () => {
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);
    eventBus.publish.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.handleKoraWebhook(webhookBody(), 'sig'),
    ).resolves.toBeUndefined();

    expect(eventBus.publish).toHaveBeenCalled();
  });

  it('does not throw when looking up the user for notification fails, since the funding already posted', async () => {
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockRejectedValue(new Error('db blip'));

    await expect(
      service.handleKoraWebhook(webhookBody(), 'sig'),
    ).resolves.toBeUndefined();

    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.handleKoraWebhook (refund events)', () => {
  let ledgerService: CompletionLedger;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: PaymentsService;

  function refundBody(
    event: string,
    overrides: Partial<Record<string, unknown>> = {},
  ) {
    return Buffer.from(
      JSON.stringify({
        event,
        data: {
          amount: 5000,
          status: event === 'refund.failed' ? 'failed' : 'success',
          currency: 'NGN',
          reference: 'rfd-funding-1-1',
          payment_reference: 'KPY-CA-abc',
          ...overrides,
        },
      }),
      'utf8',
    );
  }

  beforeEach(() => {
    ledgerService = completionLedger();
    usersService = { findById: jest.fn() };
    eventBus = { publish: jest.fn() };
    service = new PaymentsService(
      inlineTransaction,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      completionKyc() as unknown as KycService,
      eventBus as unknown as EventBusService,
      mockAdapter(),
      testConfig,
    );
  });

  it('settles a successful refund by its own reference, never the Kora-internal payment_reference, and publishes funding_refunded', async () => {
    ledgerService.settleRefund.mockResolvedValue({
      userId: 'user-1',
      netAmount: Money.of(500_000n, 'NGN'),
      fundingReference: 'cliqpay-ref-1',
      refundReference: 'rfd-funding-1-1',
    });
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.handleKoraWebhook(refundBody('refund.success'), 'sig');

    expect(ledgerService.settleRefund).toHaveBeenCalledWith({
      refundReference: 'rfd-funding-1-1',
      providerReportedAmount: Money.of(500_000n, 'NGN'),
    });
    const published = eventBus.publish.mock.calls[0][0] as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(published.name).toBe(FUNDING_REFUNDED_EVENT);
    expect(published.payload).toMatchObject({
      userId: 'user-1',
      amount: '5000.00',
      reference: 'cliqpay-ref-1',
    });
  });

  it('publishes nothing for a duplicate, unknown or mismatched settlement', async () => {
    ledgerService.settleRefund.mockResolvedValue(null);

    await service.handleKoraWebhook(refundBody('refund.success'), 'sig');

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('alerts ops when a success arrives for an attempt after the funding was already refunded', async () => {
    ledgerService.settleRefund.mockResolvedValue(null);
    ledgerService.findRefundContext.mockResolvedValue({
      attemptStatus: 'failed',
      fundingStatus: 'refunded',
      fundingReference: 'cliqpay-ref-1',
      netAmount: Money.of(500_000n, 'NGN'),
    });

    await service.handleKoraWebhook(refundBody('refund.success'), 'sig');

    const published = eventBus.publish.mock.calls[0][0] as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(published.name).toBe(REFUND_ATTENTION_REQUIRED_EVENT);
    expect(published.payload).toMatchObject({
      email: 'ops@cliqpay.test',
      reason: 'late_success_after_refunded',
      fundingReference: 'cliqpay-ref-1',
      refundReference: 'rfd-funding-1-1',
      amount: '5000.00',
    });
  });

  it('does not alert on a duplicate success for the attempt that settled the funding', async () => {
    ledgerService.settleRefund.mockResolvedValue(null);
    ledgerService.findRefundContext.mockResolvedValue({
      attemptStatus: 'completed',
      fundingStatus: 'refunded',
      fundingReference: 'cliqpay-ref-1',
      netAmount: Money.of(500_000n, 'NGN'),
    });

    await service.handleKoraWebhook(refundBody('refund.success'), 'sig');

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('fails the attempt with Kora’s status_reason on refund.failed', async () => {
    await service.handleKoraWebhook(
      refundBody('refund.failed', { status_reason: 'Insufficient balance' }),
      'sig',
    );

    expect(ledgerService.failRefund).toHaveBeenCalledWith({
      refundReference: 'rfd-funding-1-1',
      reason: 'Insufficient balance',
    });
    expect(ledgerService.settleRefund).not.toHaveBeenCalled();
  });

  it('ignores a refund that is still processing', async () => {
    await service.handleKoraWebhook(
      refundBody('refund.success', { status: 'processing' }),
      'sig',
    );

    expect(ledgerService.settleRefund).not.toHaveBeenCalled();
    expect(ledgerService.failRefund).not.toHaveBeenCalled();
  });

  it('rejects a payload without a reference as malformed', async () => {
    await expect(
      service.handleKoraWebhook(
        refundBody('refund.success', { reference: undefined }),
        'sig',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PaymentsService.pollStaleFundingTransactions', () => {
  let ledgerService: CompletionLedger &
    jest.Mocked<Pick<LedgerService, 'findStaleFundingTransactions'>>;
  let kycService: ReturnType<typeof completionKyc>;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let adapter: jest.Mocked<PaymentProviderAdapter>;
  let service: PaymentsService;

  const staleTransaction = { reference: 'cliqpay-ref-1', currency: 'NGN' };
  const postFundingResult: PostFundingResult = {
    userId: 'user-1',
    netAmount: Money.of(500_000n, 'NGN'),
    reference: 'cliqpay-ref-1',
  };

  beforeEach(() => {
    ledgerService = {
      ...completionLedger(),
      findStaleFundingTransactions: jest.fn().mockResolvedValue([]),
    };
    kycService = completionKyc();
    usersService = { findById: jest.fn() };
    eventBus = { publish: jest.fn() };
    adapter = mockAdapter();
    service = new PaymentsService(
      inlineTransaction,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      kycService as unknown as KycService,
      eventBus as unknown as EventBusService,
      adapter,
      testConfig,
    );
  });

  it('does nothing when there are no stale transactions', async () => {
    await service.pollStaleFundingTransactions();

    expect(adapter.verifyCharge.mock.calls).toHaveLength(0);
    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('credits through the cap check and publishes when Kora reports success', async () => {
    ledgerService.findStaleFundingTransactions.mockResolvedValue([
      staleTransaction,
    ]);
    adapter.verifyCharge.mockResolvedValue({
      status: 'success',
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.pollStaleFundingTransactions();

    expect(ledgerService.postFundingWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        reference: 'cliqpay-ref-1',
        netAmount: Money.of(500_000n, 'NGN'),
        providerFee: Money.of(5_000n, 'NGN'),
        providerStatus: 'success',
      },
    );
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
  });

  it('marks the transaction failed via postFunding when Kora reports failed', async () => {
    ledgerService.findStaleFundingTransactions.mockResolvedValue([
      staleTransaction,
    ]);
    adapter.verifyCharge.mockResolvedValue({ status: 'failed' });
    ledgerService.postFunding.mockResolvedValue(null);

    await service.pollStaleFundingTransactions();

    expect(ledgerService.postFunding).toHaveBeenCalledWith({
      reference: 'cliqpay-ref-1',
      netAmount: Money.zero('NGN'),
      providerFee: Money.zero('NGN'),
      providerStatus: 'failed',
    });
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('leaves the transaction pending when Kora reports still-unresolved', async () => {
    ledgerService.findStaleFundingTransactions.mockResolvedValue([
      staleTransaction,
    ]);
    adapter.verifyCharge.mockResolvedValue({ status: 'pending' });

    await service.pollStaleFundingTransactions();

    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('is a no-op when postFunding reports the transaction was already resolved (race with the webhook)', async () => {
    ledgerService.findStaleFundingTransactions.mockResolvedValue([
      staleTransaction,
    ]);
    adapter.verifyCharge.mockResolvedValue({
      status: 'success',
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });
    ledgerService.postFundingWithinTransaction.mockResolvedValue(null);

    await service.pollStaleFundingTransactions();

    expect(usersService.findById).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('does not let one failing verifyCharge call stop the rest of the batch', async () => {
    ledgerService.findStaleFundingTransactions.mockResolvedValue([
      staleTransaction,
      { reference: 'cliqpay-ref-2', currency: 'NGN' },
    ]);
    adapter.verifyCharge.mockRejectedValueOnce(new Error('network blip'));
    adapter.verifyCharge.mockResolvedValueOnce({
      status: 'success',
      netAmount: Money.of(100_000n, 'NGN'),
      providerFee: Money.of(1_000n, 'NGN'),
    });
    ledgerService.postFundingWithinTransaction.mockResolvedValue(
      postFundingResult,
    );
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.pollStaleFundingTransactions();

    expect(ledgerService.postFundingWithinTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentsService.reconcileFloatBalances', () => {
  let ledgerService: jest.Mocked<Pick<LedgerService, 'getFloatBalance'>>;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let adapter: FakeAdapter;
  let service: PaymentsService;

  beforeEach(() => {
    ledgerService = { getFloatBalance: jest.fn() };
    usersService = { findById: jest.fn() };
    eventBus = { publish: jest.fn() };
    adapter = new FakeAdapter();
    service = new PaymentsService(
      {} as DataSource,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      {} as KycService,
      eventBus as unknown as EventBusService,
      adapter,
      testConfig,
    );
  });

  it('does not publish when the ledger and provider balances match', async () => {
    ledgerService.getFloatBalance.mockResolvedValue(Money.of(500_000n, 'NGN'));
    adapter.setBalance('NGN', Money.of(500_000n, 'NGN'));

    await service.reconcileFloatBalances();

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('publishes reconciliation_mismatch with both values and the delta when they diverge', async () => {
    ledgerService.getFloatBalance.mockResolvedValue(Money.of(500_000n, 'NGN'));
    adapter.setBalance('NGN', Money.of(480_000n, 'NGN'));

    await service.reconcileFloatBalances();

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const published = eventBus.publish.mock.calls[0][0] as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(published.name).toBe(RECONCILIATION_MISMATCH_EVENT);
    expect(published.payload).toMatchObject({
      email: 'ops@cliqpay.test',
      provider: 'kora',
      currency: 'NGN',
      ledgerBalance: '5000.00',
      providerBalance: '4800.00',
      delta: '200.00',
    });
    expect(typeof published.payload.occurredAt).toBe('string');
  });

  it('does not let one pair failing to reconcile stop the rest of the batch', async () => {
    ledgerService.getFloatBalance.mockRejectedValueOnce(new Error('db blip'));

    await expect(service.reconcileFloatBalances()).resolves.toBeUndefined();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.pollStaleRefundTransactions', () => {
  it('runs the retry and alert steps even when resolving stale refunds fails', async () => {
    const ledgerService = completionLedger();
    ledgerService.findStalePendingRefunds.mockRejectedValue(
      new Error('db blip'),
    );
    const service = new PaymentsService(
      inlineTransaction,
      ledgerService as unknown as LedgerService,
      { findById: jest.fn() } as unknown as UsersService,
      completionKyc() as unknown as KycService,
      { publish: jest.fn() } as unknown as EventBusService,
      mockAdapter(),
      testConfig,
    );

    await expect(
      service.pollStaleRefundTransactions(),
    ).resolves.toBeUndefined();

    expect(ledgerService.findHeldFundings.mock.calls).toHaveLength(2);
  });
});
