import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import {
  holdAFunding,
  refundWebhookData,
  signedRefundWebhook,
  waitFor,
} from './support/funding-completion';
import { assertInvariantHolds } from './support/ledger-invariant';
import { REFUND_POLL_QUEUE } from '../../src/modules/payments/internal/refund-poll.processor';
import { Money } from '../../src/shared/primitives/money';

jest.setTimeout(240_000);

const AMOUNT = 1_000_000n;
const OPS = 'ops@cliqpay.test';
const MINUTE = 60;

describe('refund recovery poll', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  type Held = Awaited<ReturnType<typeof holdAFunding>>;

  const statusOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference })).status;

  // Moves an attempt row back in time, the way real waiting would.
  async function age(reference: string, seconds: number) {
    await ctx.transactionRepo.query(
      `UPDATE transactions SET created_at = now() - make_interval(secs => $2), updated_at = now() - make_interval(secs => $2) WHERE reference = $1`,
      [reference, seconds],
    );
  }

  async function ageFunding(reference: string, heldSecondsAgo: number) {
    await ctx.transactionRepo.query(
      `UPDATE transactions SET metadata = metadata || jsonb_build_object('heldAt', to_char(now() - make_interval(secs => $2), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE reference = $1`,
      [reference, heldSecondsAgo],
    );
  }

  const attemptRef = (held: Held, n: number) => `rfd-${held.fundingId}-${n}`;

  const opsAlerts = (fundingReference: string) =>
    ctx.emailAdapter.sent.filter(
      (m) => m.to === OPS && m.html.includes(fundingReference),
    );

  it('registers a repeatable 5-minute job scheduler', async () => {
    const queue = ctx.app.get<Queue>(getQueueToken(REFUND_POLL_QUEUE));

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ every: 300_000 });
  });

  describe('stale pending attempts', () => {
    it('leaves a recent attempt alone', async () => {
      const held = await holdAFunding(ctx);
      const spy = jest.spyOn(ctx.fakeAdapter, 'verifyRefund');

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(
        spy.mock.calls.filter(([ref]) => ref === held.refundReference),
      ).toHaveLength(0);
      spy.mockRestore();
    });

    it('settles an attempt Kora reports as paid, using the provider amount, and tells the user', async () => {
      const held = await holdAFunding(ctx);
      await age(held.refundReference, 6 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'success',
        amount: Money.of(AMOUNT, 'NGN'),
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(await statusOf(held.refundReference)).toBe('completed');
      expect(await statusOf(held.reference)).toBe('refunded');
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === held.email && m.subject.includes('refund has been sent'),
        ),
      );
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('fails an attempt Kora reports as failed and leaves the funding held', async () => {
      const held = await holdAFunding(ctx);
      await age(held.refundReference, 6 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'failed',
        reason: 'Refund failed at the provider',
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(await statusOf(held.refundReference)).toBe('failed');
      expect(await statusOf(held.reference)).toBe('held');
    });

    it('leaves an attempt that is still pending at Kora', async () => {
      const held = await holdAFunding(ctx);
      await age(held.refundReference, 6 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'pending',
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(await statusOf(held.refundReference)).toBe('pending');
    });

    it('initiates again with the same reference when Kora never saw the refund', async () => {
      const initiate = jest.spyOn(ctx.fakeAdapter, 'initiateRefund');
      initiate.mockRejectedValueOnce(new Error('connection reset'));
      const held = await holdAFunding(ctx);
      initiate.mockRestore();
      expect(
        ctx.fakeAdapter.refundsInitiated.filter(
          (r) => r.reference === held.refundReference,
        ),
      ).toHaveLength(0);
      await age(held.refundReference, 6 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'not_found',
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(ctx.fakeAdapter.refundsInitiated).toContainEqual({
        reference: held.refundReference,
        paymentReference: held.reference,
        amount: Money.of(AMOUNT, 'NGN'),
        reason: expect.any(String) as unknown,
      });
      expect(await statusOf(held.refundReference)).toBe('pending');
    });

    it('does not let one failing verification stop the rest of the batch', async () => {
      const broken = await holdAFunding(ctx);
      const fine = await holdAFunding(ctx);
      await age(broken.refundReference, 6 * MINUTE);
      await age(fine.refundReference, 6 * MINUTE);
      const spy = jest.spyOn(ctx.fakeAdapter, 'verifyRefund');
      spy.mockImplementation((reference) =>
        reference === broken.refundReference
          ? Promise.reject(new Error('network blip'))
          : Promise.resolve({
              status: 'success' as const,
              amount: Money.of(AMOUNT, 'NGN'),
            }),
      );

      await ctx.paymentsService.pollStaleRefundTransactions();
      spy.mockRestore();

      expect(await statusOf(broken.refundReference)).toBe('pending');
      expect(await statusOf(fine.refundReference)).toBe('completed');
    });
  });

  describe('bounded retry', () => {
    const delays = [
      10 * MINUTE,
      60 * MINUTE,
      6 * 60 * MINUTE,
      24 * 60 * MINUTE,
    ];

    it('starts attempts 2 to 5 only after 10 minutes, 1 hour, 6 hours and 24 hours, each with a new reference, and then stops', async () => {
      const held = await holdAFunding(ctx);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const delay = delays[attempt - 1];
        await ctx.ledgerService.failRefund({
          refundReference: attemptRef(held, attempt),
          reason: `failure ${attempt}`,
        });

        await age(attemptRef(held, attempt), delay - MINUTE);
        await ctx.paymentsService.pollStaleRefundTransactions();
        expect(
          await ctx.transactionRepo.findOneBy({
            reference: attemptRef(held, attempt + 1),
          }),
        ).toBeNull();

        await age(attemptRef(held, attempt), delay + MINUTE);
        await ctx.paymentsService.pollStaleRefundTransactions();
        expect(await statusOf(attemptRef(held, attempt + 1))).toBe('pending');
        expect(
          ctx.fakeAdapter.refundsInitiated.map((r) => r.reference),
        ).toContain(attemptRef(held, attempt + 1));
      }

      await ctx.ledgerService.failRefund({
        refundReference: attemptRef(held, 5),
        reason: 'failure 5',
      });
      await age(attemptRef(held, 5), 100 * 60 * MINUTE);
      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(
        await ctx.transactionRepo.findOneBy({
          reference: attemptRef(held, 6),
        }),
      ).toBeNull();
      expect(await statusOf(held.reference)).toBe('held');
    });

    it('never starts a second attempt while one is pending', async () => {
      const held = await holdAFunding(ctx);
      await age(held.refundReference, 100 * 60 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'pending',
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(
        await ctx.transactionRepo.findOneBy({
          reference: attemptRef(held, 2),
        }),
      ).toBeNull();
    });
  });

  describe('ops alerts', () => {
    async function exhaust(held: Held) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        if (attempt > 1) {
          await ctx.ledgerService.startRefundAttempt(held.fundingId);
        }
        await ctx.ledgerService.failRefund({
          refundReference: attemptRef(held, attempt),
          reason: `failure ${attempt}`,
        });
      }
    }

    it('alerts when retries are exhausted, with the last failure, and not again within a day', async () => {
      const held = await holdAFunding(ctx);
      await exhaust(held);

      await ctx.paymentsService.pollStaleRefundTransactions();
      await waitFor(() => opsAlerts(held.reference).length >= 1);
      await ctx.paymentsService.pollStaleRefundTransactions();

      const alerts = opsAlerts(held.reference);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].subject).toContain('Refund needs attention');
      expect(alerts[0].html).toContain('failure 5');
      expect(alerts[0].html).toContain('retries_exhausted');
    });

    it('repeats the alert once a day has passed', async () => {
      const held = await holdAFunding(ctx);
      await exhaust(held);
      await ctx.paymentsService.pollStaleRefundTransactions();
      await waitFor(() => opsAlerts(held.reference).length >= 1);
      await ctx.ledgerService.setRefundAlerts(held.fundingId, {
        retries_exhausted: new Date(
          Date.now() - 25 * 60 * 60 * 1000,
        ).toISOString(),
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      await waitFor(() => opsAlerts(held.reference).length >= 2);
    });

    it('alerts when money has been held for 24 hours even though a refund is still pending, once per day', async () => {
      const held = await holdAFunding(ctx);
      await ageFunding(held.reference, 25 * 60 * MINUTE);
      ctx.fakeAdapter.setVerifyRefundResult(held.refundReference, {
        status: 'pending',
      });

      await ctx.paymentsService.pollStaleRefundTransactions();
      await waitFor(() => opsAlerts(held.reference).length >= 1);
      await ctx.paymentsService.pollStaleRefundTransactions();

      const alerts = opsAlerts(held.reference);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].html).toContain('held_too_long');
    });

    it('stays quiet for money held less than 24 hours', async () => {
      const held = await holdAFunding(ctx);
      await ageFunding(held.reference, 23 * 60 * MINUTE);

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(opsAlerts(held.reference)).toHaveLength(0);
    });

    it('does not alert about a funding that has been refunded', async () => {
      const held = await holdAFunding(ctx);
      await ageFunding(held.reference, 30 * 60 * MINUTE);
      await ctx.ledgerService.settleRefund({
        refundReference: held.refundReference,
        providerReportedAmount: Money.of(AMOUNT, 'NGN'),
      });

      await ctx.paymentsService.pollStaleRefundTransactions();

      expect(opsAlerts(held.reference)).toHaveLength(0);
    });
  });

  describe('late success', () => {
    const deliverSuccess = (reference: string) => {
      const { body, signature } = signedRefundWebhook(
        'refund.success',
        refundWebhookData(reference, AMOUNT),
      );
      return ctx.paymentsService.handleKoraWebhook(
        Buffer.from(body),
        signature,
      );
    };

    it('settles the funding from a late success on a failed attempt and cancels the pending retry', async () => {
      const held = await holdAFunding(ctx);
      await ctx.ledgerService.failRefund({
        refundReference: attemptRef(held, 1),
        reason: 'timed out',
      });
      await ctx.ledgerService.startRefundAttempt(held.fundingId);

      await deliverSuccess(attemptRef(held, 1));

      expect(await statusOf(held.reference)).toBe('refunded');
      expect(await statusOf(attemptRef(held, 1))).toBe('completed');
      expect(await statusOf(attemptRef(held, 2))).toBe('failed');
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('alerts ops when a success arrives for an attempt after another attempt already refunded the funding', async () => {
      const held = await holdAFunding(ctx);
      await ctx.ledgerService.failRefund({
        refundReference: attemptRef(held, 1),
        reason: 'timed out',
      });
      await ctx.ledgerService.startRefundAttempt(held.fundingId);
      await deliverSuccess(attemptRef(held, 2));
      expect(await statusOf(held.reference)).toBe('refunded');

      await deliverSuccess(attemptRef(held, 1));

      await waitFor(() => opsAlerts(held.reference).length >= 1);
      expect(opsAlerts(held.reference)[0].html).toContain(
        'late_success_after_refunded',
      );
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('does not alert on a plain duplicate delivery of the success that settled the funding', async () => {
      const held = await holdAFunding(ctx);
      await deliverSuccess(attemptRef(held, 1));

      await deliverSuccess(attemptRef(held, 1));

      expect(opsAlerts(held.reference)).toHaveLength(0);
    });
  });
});
