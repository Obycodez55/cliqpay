import * as request from 'supertest';
import {
  DisputesTestContext,
  createDisputesTestContext,
  destroyDisputesTestContext,
  fundWallet,
  seedDisputesUser,
} from './support/disputes-test-context';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';

jest.setTimeout(180_000);

interface RecordChargebackBody {
  originalTransactionReference: string;
  amount: number;
  disputeReference: string;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('POST /disputes/chargebacks', () => {
  let ctx: DisputesTestContext;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createDisputesTestContext();
  });

  afterAll(async () => {
    await destroyDisputesTestContext(ctx);
  });

  function nextIdentity(prefix: string) {
    idSeq += 1;
    const n = idSeq;
    return {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348055${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedUser(balanceMinor = 500_000n) {
    const identity = nextIdentity('dispute');
    const { userId, walletId } = await seedDisputesUser(ctx, identity);
    const reference = `cliqpay-fund-${userId}`;
    await fundWallet(ctx, {
      reference,
      walletId,
      netAmountMinor: balanceMinor,
    });
    return {
      userId,
      walletId,
      fundingReference: reference,
      email: identity.email,
    };
  }

  function post(body: RecordChargebackBody, secret: string | undefined) {
    const req = request(ctx.app.getHttpServer()).post('/disputes/chargebacks');
    if (secret !== undefined) {
      req.set('X-Internal-Secret', secret);
    }
    return req.send(body);
  }

  describe('guard', () => {
    it('rejects a request with no X-Internal-Secret header', async () => {
      const { fundingReference } = await seedFundedUser();

      const res = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference: `dispute-${fundingReference}-1`,
        },
        undefined,
      );

      expect(res.status).toBe(401);
    });

    it('rejects a request with the wrong secret', async () => {
      const { fundingReference } = await seedFundedUser();

      const res = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference: `dispute-${fundingReference}-2`,
        },
        'the-wrong-secret-value-entirely-00000000',
      );

      expect(res.status).toBe(401);
    });
  });

  describe('recording a chargeback', () => {
    it('posts the compensating transaction, flips the original to disputed, and does not freeze when balance stays non-negative', async () => {
      const { walletId, fundingReference, email } =
        await seedFundedUser(500_000n);
      const disputeReference = `dispute-${fundingReference}-3`;

      const res = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 200_000,
          disputeReference,
        },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        disputeReference,
        status: 'open',
        amount: { amount: '200000', currency: 'NGN' },
        accountFrozen: false,
      });

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(300_000n);

      const original = await ctx.transactionRepo.findOneByOrFail({
        reference: fundingReference,
      });
      expect(original.status).toBe('disputed');

      const dispute = await ctx.disputeRepo.findOneByOrFail({
        disputeReference,
      });
      expect(dispute.status).toBe('open');
      expect(dispute.chargebackTransactionId).toBeTruthy();

      const chargebackTxn = await ctx.transactionRepo.findOneByOrFail({
        reference: disputeReference,
      });
      expect(chargebackTxn.type).toBe('chargeback');
      expect(chargebackTxn.reversesTransactionId).toBe(original.id);

      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (e) => e.to === email && e.subject.includes('chargeback'),
        ),
      );
    });

    it('freezes the account when the resulting balance goes strictly negative', async () => {
      const { userId, walletId, fundingReference } =
        await seedFundedUser(100_000n);
      const disputeReference = `dispute-${fundingReference}-freeze`;

      // The chargeback cap is against the original funded amount (§4.2),
      // not the current balance — driving the balance negative requires
      // the user to have already spent some of it elsewhere first. No
      // spend path (transfers/withdrawals) is wired into this test context
      // (out of this module's dependency graph — ADR-0016), so a direct
      // balance mutation stands in for "already spent 80,000 of this
      // elsewhere" without exercising real spend logic, which isn't what
      // this test is about.
      await ctx.accountRepo.update({ id: walletId }, { balance: 20_000n });

      const res = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference,
        },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      const body = res.body as { accountFrozen: boolean };
      expect(body.accountFrozen).toBe(true);

      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.isFrozen).toBe(true);

      await waitFor(() =>
        ctx.emailAdapter.sent.some((e) => e.subject.includes('restricted')),
      );
    });

    it('does not freeze when the chargeback exactly zeroes the balance', async () => {
      const { userId, fundingReference } = await seedFundedUser(100_000n);
      const disputeReference = `dispute-${fundingReference}-exact-zero`;

      const res = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference,
        },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      const body = res.body as { accountFrozen: boolean };
      expect(body.accountFrozen).toBe(false);

      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.isFrozen).toBe(false);
    });

    it('rejects a repeat dispute_reference instead of re-posting', async () => {
      const { walletId, fundingReference } = await seedFundedUser(500_000n);
      const disputeReference = `dispute-${fundingReference}-dup`;

      const first = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(first.status).toBe(201);

      const second = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second.status).toBe(409);

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(400_000n);
    });

    it('rejects an amount exceeding the original amount minus prior chargebacks', async () => {
      const { fundingReference } = await seedFundedUser(500_000n);

      const first = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 400_000,
          disputeReference: `dispute-${fundingReference}-partial-1`,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(first.status).toBe(201);

      // Only 100_000 remains chargebackable; requesting more must fail.
      const second = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 150_000,
          disputeReference: `dispute-${fundingReference}-partial-2`,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second.status).toBe(422);

      const original = await ctx.transactionRepo.findOneByOrFail({
        reference: fundingReference,
      });
      // Still disputed from the first, successful partial chargeback — the
      // rejected second attempt posted nothing.
      expect(original.status).toBe('disputed');
    });

    it('allows a further partial chargeback against an already-disputed original, up to the remaining cap', async () => {
      const { walletId, fundingReference } = await seedFundedUser(500_000n);

      const first = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 300_000,
          disputeReference: `dispute-${fundingReference}-multi-1`,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(first.status).toBe(201);

      const second = await post(
        {
          originalTransactionReference: fundingReference,
          amount: 200_000,
          disputeReference: `dispute-${fundingReference}-multi-2`,
        },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second.status).toBe(201);

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(0n);
    });

    it('rejects an original transaction reference that does not exist', async () => {
      const res = await post(
        {
          originalTransactionReference: 'no-such-reference',
          amount: 100_000,
          disputeReference: 'dispute-no-such-reference',
        },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(404);
    });
  });
});
