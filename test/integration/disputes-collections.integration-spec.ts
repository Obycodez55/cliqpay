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

describe('GET /disputes/collections', () => {
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
    const identity = nextIdentity('collections');
    const { userId, walletId } = await seedDisputesUser(ctx, identity);
    const reference = `cliqpay-fund-${userId}`;
    await fundWallet(ctx, {
      reference,
      walletId,
      netAmountMinor: balanceMinor,
    });
    return { userId, walletId, fundingReference: reference };
  }

  function recordChargeback(body: {
    originalTransactionReference: string;
    amount: number;
    disputeReference: string;
  }) {
    return request(ctx.app.getHttpServer())
      .post('/disputes/chargebacks')
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .send(body);
  }

  function getCollections(secret: string | undefined) {
    const req = request(ctx.app.getHttpServer()).get('/disputes/collections');
    if (secret !== undefined) {
      req.set('X-Internal-Secret', secret);
    }
    return req;
  }

  describe('guard', () => {
    it('rejects a request with no X-Internal-Secret header', async () => {
      const res = await getCollections(undefined);
      expect(res.status).toBe(401);
    });

    it('rejects a request with the wrong secret', async () => {
      const res = await getCollections('the-wrong-secret-value-entirely-00');
      expect(res.status).toBe(401);
    });
  });

  describe('collections view', () => {
    it('shows a negative-balance wallet with its chargeback and dispute status', async () => {
      // Balance goes negative the same way disputes-record-chargeback's
      // freeze test does: a direct balance mutation stands in for prior
      // spend elsewhere, since no spend path is wired into this test
      // context (ADR-0016) and that isn't what this test is about.
      const { userId, walletId, fundingReference } =
        await seedFundedUser(100_000n);
      await ctx.accountRepo.update({ id: walletId }, { balance: 20_000n });
      const disputeReference = `dispute-${fundingReference}-collections`;

      const chargebackRes = await recordChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference,
      });
      expect(chargebackRes.status).toBe(201);

      const res = await getCollections(TEST_INTERNAL_API_SECRET);

      expect(res.status).toBe(200);
      const entry = (
        res.body as Array<{
          userId: string;
          chargebacks: Array<{ chargebackTransactionId: string }>;
        }>
      ).find((e) => e.userId === userId);
      expect(entry).toMatchObject({
        userId,
        balance: { amount: '-80000', currency: 'NGN' },
        isFrozen: true,
        chargebacks: [
          {
            disputeReference,
            disputeStatus: 'open',
            amount: { amount: '100000', currency: 'NGN' },
          },
        ],
      });
      expect(entry?.chargebacks[0].chargebackTransactionId).toBeTruthy();
    });

    it('does not list a wallet whose balance stayed non-negative', async () => {
      const { userId, fundingReference } = await seedFundedUser(500_000n);
      await recordChargeback({
        originalTransactionReference: fundingReference,
        amount: 200_000,
        disputeReference: `dispute-${fundingReference}-non-negative`,
      });

      const res = await getCollections(TEST_INTERNAL_API_SECRET);

      expect(res.status).toBe(200);
      const entry = (res.body as Array<{ userId: string }>).find(
        (e) => e.userId === userId,
      );
      expect(entry).toBeUndefined();
    });

    it('lists every chargeback contributing to a still-negative wallet', async () => {
      const { userId, walletId, fundingReference } =
        await seedFundedUser(500_000n);
      await ctx.accountRepo.update({ id: walletId }, { balance: 50_000n });
      const firstReference = `dispute-${fundingReference}-multi-1`;
      const secondReference = `dispute-${fundingReference}-multi-2`;

      const first = await recordChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference: firstReference,
      });
      expect(first.status).toBe(201);
      const second = await recordChargeback({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference: secondReference,
      });
      expect(second.status).toBe(201);

      const res = await getCollections(TEST_INTERNAL_API_SECRET);

      const entry = (
        res.body as Array<{
          userId: string;
          chargebacks: Array<{ disputeReference: string }>;
        }>
      ).find((e) => e.userId === userId);
      expect(entry?.chargebacks.map((c) => c.disputeReference).sort()).toEqual(
        [firstReference, secondReference].sort(),
      );
    });
  });
});
