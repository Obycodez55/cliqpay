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

interface ResolveDisputeBody {
  disputeReference: string;
  outcome: 'upheld' | 'resolved';
  amount?: number;
}

describe('POST /disputes/resolve', () => {
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
      phone: `+2348055${String(400_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedUser(balanceMinor = 500_000n) {
    const identity = nextIdentity('resolve');
    const { userId, walletId } = await seedDisputesUser(ctx, identity);
    const reference = `cliqpay-fund-${userId}`;
    await fundWallet(ctx, {
      reference,
      walletId,
      netAmountMinor: balanceMinor,
    });
    return { userId, walletId, fundingReference: reference };
  }

  function postChargeback(body: RecordChargebackBody) {
    return request(ctx.app.getHttpServer())
      .post('/disputes/chargebacks')
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .send(body);
  }

  function postResolve(body: ResolveDisputeBody, secret: string | undefined) {
    const req = request(ctx.app.getHttpServer()).post('/disputes/resolve');
    if (secret !== undefined) {
      req.set('X-Internal-Secret', secret);
    }
    return req.send(body);
  }

  // Seeds a funded user, records a chargeback that leaves the balance
  // strictly negative (so the freeze/unfreeze half of resolution is
  // actually exercised), and returns everything a resolve test needs.
  async function seedOpenDispute(overrides: {
    fundedMinor: bigint;
    chargebackMinor: number;
  }) {
    const { userId, walletId, fundingReference } = await seedFundedUser(
      overrides.fundedMinor,
    );
    const disputeReference = `dispute-${fundingReference}-resolve`;

    const chargeback = await postChargeback({
      originalTransactionReference: fundingReference,
      amount: overrides.chargebackMinor,
      disputeReference,
    });
    expect(chargeback.status).toBe(201);

    return { userId, walletId, fundingReference, disputeReference };
  }

  describe('guard', () => {
    it('rejects a request with no X-Internal-Secret header', async () => {
      const { disputeReference } = await seedOpenDispute({
        fundedMinor: 500_000n,
        chargebackMinor: 100_000,
      });

      const res = await postResolve(
        { disputeReference, outcome: 'upheld' },
        undefined,
      );

      expect(res.status).toBe(401);
    });
  });

  describe('upheld', () => {
    it('flips the dispute to upheld, flips the original to reversed, and leaves balance/freeze untouched', async () => {
      const { userId, walletId, fundingReference, disputeReference } =
        await seedOpenDispute({
          fundedMinor: 100_000n,
          chargebackMinor: 100_000,
        });

      const walletBefore = await ctx.accountRepo.findOneByOrFail({
        id: walletId,
      });
      const userBefore = await ctx.userRepo.findOneByOrFail({ id: userId });

      const res = await postResolve(
        { disputeReference, outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        disputeReference,
        status: 'upheld',
        accountUnfrozen: false,
      });

      const dispute = await ctx.disputeRepo.findOneByOrFail({
        disputeReference,
      });
      expect(dispute.status).toBe('upheld');
      expect(dispute.resolvedAt).toBeTruthy();

      const original = await ctx.transactionRepo.findOneByOrFail({
        reference: fundingReference,
      });
      expect(original.status).toBe('reversed');

      const walletAfter = await ctx.accountRepo.findOneByOrFail({
        id: walletId,
      });
      expect(walletAfter.balance).toBe(walletBefore.balance);

      const userAfter = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(userAfter.isFrozen).toBe(userBefore.isFrozen);
    });

    it('leaves an existing freeze standing', async () => {
      // A 100,000 chargeback against a 80,000 balance drives the wallet to
      // -20,000, freezing the account (same technique as the
      // record-chargeback suite's freeze test — no spend path is wired into
      // this test context, ADR-0016).
      const { userId, walletId, fundingReference } =
        await seedFundedUser(100_000n);
      await ctx.accountRepo.update({ id: walletId }, { balance: 80_000n });
      const disputeReference = `dispute-${fundingReference}-upheld-frozen`;
      const chargeback = await postChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference,
      });
      expect(chargeback.status).toBe(201);
      expect(
        (chargeback.body as { accountFrozen: boolean }).accountFrozen,
      ).toBe(true);

      const res = await postResolve(
        { disputeReference, outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.isFrozen).toBe(true);
    });
  });

  describe('resolved', () => {
    it('restores the balance, flips the original back to completed, and unfreezes', async () => {
      // 100,000 chargeback against a 80,000 balance -> -20,000, frozen.
      const { userId, walletId, fundingReference } =
        await seedFundedUser(100_000n);
      await ctx.accountRepo.update({ id: walletId }, { balance: 80_000n });
      const disputeReference = `dispute-${fundingReference}-resolved`;
      const chargeback = await postChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference,
      });
      expect(chargeback.status).toBe(201);

      const walletMidway = await ctx.accountRepo.findOneByOrFail({
        id: walletId,
      });
      expect(walletMidway.balance).toBe(-20_000n);

      const res = await postResolve(
        { disputeReference, outcome: 'resolved', amount: 100_000 },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        disputeReference,
        status: 'resolved',
        amount: { amount: '100000', currency: 'NGN' },
        accountUnfrozen: true,
      });

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(80_000n);

      const original = await ctx.transactionRepo.findOneByOrFail({
        reference: fundingReference,
      });
      expect(original.status).toBe('completed');

      const dispute = await ctx.disputeRepo.findOneByOrFail({
        disputeReference,
      });
      expect(dispute.status).toBe('resolved');
      expect(dispute.resolvedAt).toBeTruthy();

      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.isFrozen).toBe(false);

      const resolutionTxn = await ctx.transactionRepo.findOneByOrFail({
        reference: `${disputeReference}-resolved`,
      });
      expect(resolutionTxn.type).toBe('chargeback_reversal');
      expect(resolutionTxn.status).toBe('completed');
    });

    it('does not unfreeze when the restored balance is still negative', async () => {
      // Partial chargeback (only 50,000 of the 100,000 clawed-back amount is
      // resolved in Cliqpay's favor conceptually isn't possible — resolution
      // always reverses the full amount — so to leave the balance negative
      // after a full reversal, spend more than what was funded beyond the
      // chargeback itself: fund 100,000, manually reduce to -120,000
      // (already spent, same technique as elsewhere in this suite), then a
      // 100,000 chargeback drives it to -220,000; resolving restores only
      // the 100,000 chargeback amount, landing at -120,000 — still frozen.
      const { userId, walletId, fundingReference } =
        await seedFundedUser(100_000n);
      await ctx.accountRepo.update({ id: walletId }, { balance: -120_000n });
      const disputeReference = `dispute-${fundingReference}-still-negative`;
      const chargeback = await postChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference,
      });
      expect(chargeback.status).toBe(201);

      const res = await postResolve(
        { disputeReference, outcome: 'resolved', amount: 100_000 },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(201);
      expect((res.body as { accountUnfrozen: boolean }).accountUnfrozen).toBe(
        false,
      );

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(-120_000n);

      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.isFrozen).toBe(true);
    });

    it("rejects an amount that doesn't match the dispute's recorded amount", async () => {
      const { disputeReference } = await seedOpenDispute({
        fundedMinor: 500_000n,
        chargebackMinor: 200_000,
      });

      const res = await postResolve(
        { disputeReference, outcome: 'resolved', amount: 100_000 },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(422);

      const dispute = await ctx.disputeRepo.findOneByOrFail({
        disputeReference,
      });
      expect(dispute.status).toBe('open');
    });
  });

  describe('validation', () => {
    it('rejects a dispute_reference that does not exist', async () => {
      const res = await postResolve(
        { disputeReference: 'no-such-dispute', outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );

      expect(res.status).toBe(404);
    });

    it('rejects resolving an already-upheld dispute a second time', async () => {
      const { disputeReference } = await seedOpenDispute({
        fundedMinor: 500_000n,
        chargebackMinor: 100_000,
      });

      const first = await postResolve(
        { disputeReference, outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );
      expect(first.status).toBe(201);

      const second = await postResolve(
        { disputeReference, outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second.status).toBe(409);
    });

    it('rejects resolving an already-resolved dispute a second time', async () => {
      const { disputeReference } = await seedOpenDispute({
        fundedMinor: 500_000n,
        chargebackMinor: 100_000,
      });

      const first = await postResolve(
        { disputeReference, outcome: 'resolved', amount: 100_000 },
        TEST_INTERNAL_API_SECRET,
      );
      expect(first.status).toBe(201);

      const second = await postResolve(
        { disputeReference, outcome: 'resolved', amount: 100_000 },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second.status).toBe(409);

      const second2 = await postResolve(
        { disputeReference, outcome: 'upheld' },
        TEST_INTERNAL_API_SECRET,
      );
      expect(second2.status).toBe(409);
    });
  });

  // Regression for the same class of race disputes-record-chargeback's own
  // concurrency test guards against: two concurrent resolve attempts on the
  // *same* dispute must not both succeed — the `pessimistic_write` lock
  // DisputesService.resolveDispute takes on the `disputes` row (never a
  // pre-check race, same lesson as #34's review) must serialize them, so
  // exactly one succeeds and the other sees the already-resolved status.
  describe('concurrency', () => {
    it('never lets two concurrent resolve attempts on the same dispute both succeed', async () => {
      const { disputeReference } = await seedOpenDispute({
        fundedMinor: 500_000n,
        chargebackMinor: 100_000,
      });

      const results = await Promise.allSettled([
        postResolve(
          { disputeReference, outcome: 'resolved', amount: 100_000 },
          TEST_INTERNAL_API_SECRET,
        ),
        postResolve(
          { disputeReference, outcome: 'resolved', amount: 100_000 },
          TEST_INTERNAL_API_SECRET,
        ),
      ]);

      const responses = results.map((r) => {
        if (r.status === 'rejected') throw r.reason;
        return r.value;
      });
      const succeeded = responses.filter((r) => r.status === 201);
      const conflicted = responses.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(1);

      const dispute = await ctx.disputeRepo.findOneByOrFail({
        disputeReference,
      });
      expect(dispute.status).toBe('resolved');
    });
  });
});
