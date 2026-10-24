import * as request from 'supertest';
import { Money } from '../../src/shared/primitives/money';
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

jest.setTimeout(180_000);

const AMOUNT = 1_000_000n;

describe('Refunding a held funding through Kora', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  const statusOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference })).status;

  const deliver = (
    event: 'refund.success' | 'refund.failed',
    data: Record<string, unknown>,
    signatureOverride?: string,
  ) => {
    const { body, signature } = signedRefundWebhook(event, data);
    return request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signatureOverride ?? signature)
      .send(body);
  };

  const emailsTo = (address: string) =>
    ctx.emailAdapter.sent.filter((m) => m.to === address);

  describe('initiation after a hold', () => {
    it('asks Kora to refund exactly the credited principal, against the funding reference, once the hold has committed', async () => {
      const held = await holdAFunding(ctx);

      expect(ctx.fakeAdapter.refundsInitiated).toContainEqual({
        reference: held.refundReference,
        paymentReference: held.reference,
        amount: Money.of(AMOUNT, 'NGN'),
        reason: expect.any(String) as unknown,
      });
      expect(await statusOf(held.reference)).toBe('held');
      expect(await statusOf(held.refundReference)).toBe('pending');
    });

    it('emails and notifies the user that the payment is being refunded, with the cap and the fee note', async () => {
      const held = await holdAFunding(ctx);

      await waitFor(() => emailsTo(held.email).length > 0);
      const email = emailsTo(held.email)[0];
      expect(email.subject).toContain('is being refunded');
      expect(email.html).toContain('NGN 300000.00');
      expect(email.html).toContain("provider's fee is not refunded");
    });

    it('fails the attempt when Kora rejects the refund, leaving the funding held', async () => {
      const probe = await holdAFundingWithRejection();

      expect(await statusOf(probe.refundReference)).toBe('failed');
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: probe.refundReference,
      });
      expect(attempt.metadata).toMatchObject({
        failureReason: 'Transaction not found',
      });
      expect(await statusOf(probe.reference)).toBe('held');
    });

    it('leaves the attempt pending when Kora’s answer is unknown', async () => {
      const probe = await holdAFundingWithRejection({
        status: 'unknown',
        detail: 'timeout',
      });

      expect(await statusOf(probe.refundReference)).toBe('pending');
    });

    it('treats a hold whose initiation throws as held and pending, not as a failed webhook', async () => {
      const probe = await holdAFundingWithRejection(new Error('boom'));

      expect(await statusOf(probe.reference)).toBe('held');
      expect(await statusOf(probe.refundReference)).toBe('pending');
    });
  });

  async function holdAFundingWithRejection(
    outcome:
      | { status: 'rejected'; reason: string }
      | { status: 'unknown'; detail: string }
      | Error = { status: 'rejected', reason: 'Transaction not found' },
  ) {
    const spy = jest.spyOn(ctx.fakeAdapter, 'initiateRefund');
    if (outcome instanceof Error) {
      spy.mockRejectedValueOnce(outcome);
    } else {
      spy.mockResolvedValueOnce(outcome);
    }
    try {
      return await holdAFunding(ctx);
    } finally {
      spy.mockRestore();
    }
  }

  describe('refund.success webhook', () => {
    it('settles the refund: posts DR suspense / CR float, marks the funding refunded, and emails the user', async () => {
      const held = await holdAFunding(ctx);
      const wallet = await ctx.accountRepo.findOneByOrFail({
        id: held.walletId,
      });

      await deliver(
        'refund.success',
        refundWebhookData(held.refundReference, AMOUNT),
      ).expect(200);

      expect(await statusOf(held.refundReference)).toBe('completed');
      expect(await statusOf(held.reference)).toBe('refunded');
      const after = await ctx.accountRepo.findOneByOrFail({
        id: held.walletId,
      });
      expect(after.balance).toBe(wallet.balance);
      await assertInvariantHolds(ctx.accountRepo);
      await waitFor(() =>
        emailsTo(held.email).some((m) =>
          m.subject.includes('refund has been sent'),
        ),
      );
    });

    it('a duplicate delivery posts nothing and sends no second email', async () => {
      const held = await holdAFunding(ctx);
      const data = refundWebhookData(held.refundReference, AMOUNT);

      await deliver('refund.success', data).expect(200);
      await waitFor(() =>
        emailsTo(held.email).some((m) =>
          m.subject.includes('refund has been sent'),
        ),
      );
      const float = await ctx.accountRepo.findOneByOrFail({
        role: 'float',
        provider: 'kora',
        currency: 'NGN',
      });
      await deliver('refund.success', data).expect(200);

      const floatAfter = await ctx.accountRepo.findOneByOrFail({
        id: float.id,
      });
      expect(floatAfter.balance).toBe(float.balance);
      expect(
        emailsTo(held.email).filter((m) =>
          m.subject.includes('refund has been sent'),
        ),
      ).toHaveLength(1);
    });

    it('leaves the attempt pending when the reported amount differs', async () => {
      const held = await holdAFunding(ctx);

      await deliver(
        'refund.success',
        refundWebhookData(held.refundReference, AMOUNT + 100n),
      ).expect(200);

      expect(await statusOf(held.refundReference)).toBe('pending');
      expect(await statusOf(held.reference)).toBe('held');
    });

    it('answers 200 and changes nothing for a reference it does not know', async () => {
      await deliver(
        'refund.success',
        refundWebhookData('rfd-unknown-reference-1', AMOUNT),
      ).expect(200);
    });

    it('rejects an invalid signature with 401 and settles nothing', async () => {
      const held = await holdAFunding(ctx);

      await deliver(
        'refund.success',
        refundWebhookData(held.refundReference, AMOUNT),
        'deadbeef',
      ).expect(401);

      expect(await statusOf(held.refundReference)).toBe('pending');
    });

    it('ignores a refund that is not in a final state', async () => {
      const held = await holdAFunding(ctx);

      await deliver(
        'refund.success',
        refundWebhookData(held.refundReference, AMOUNT, {
          status: 'processing',
        }),
      ).expect(200);

      expect(await statusOf(held.refundReference)).toBe('pending');
    });

    it('rejects a malformed payload with 400', async () => {
      await deliver('refund.success', { status: 'success' }).expect(400);
    });
  });

  describe('refund.failed webhook', () => {
    it('fails the attempt with Kora’s reason, posts nothing, and leaves the funding held', async () => {
      const held = await holdAFunding(ctx);

      await deliver(
        'refund.failed',
        refundWebhookData(held.refundReference, AMOUNT, {
          status: 'failed',
          status_reason: 'Insufficient balance',
        }),
      ).expect(200);

      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      expect(attempt.status).toBe('failed');
      expect(attempt.metadata).toMatchObject({
        failureReason: 'Insufficient balance',
      });
      expect(await statusOf(held.reference)).toBe('held');
      await assertInvariantHolds(ctx.accountRepo);
    });
  });
});
