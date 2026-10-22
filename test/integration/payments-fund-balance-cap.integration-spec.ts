import { createHmac } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { Money } from '../../src/shared/primitives/money';
import { KycTier } from '../../src/modules/users/users.service';
import { BalanceCapExceededException } from '../../src/modules/kyc/internal/errors';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';

import { holdUserLock, trackSettled, waitBriefly } from './support/user-lock';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const FAKE_SECRET_KEY = 'fake-kora-secret-key';

// Seeded tier1 NGN balance cap (CreateTierLimits migration), in kobo.
const TIER1_CAP = 30_000_000;

describe('Balance cap at funding initiation', () => {
  let ctx: PaymentsTestContext;
  let jwtService: JwtService;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(tier: KycTier = 'tier1') {
    seq += 1;
    return seedUserWithWallet(ctx, {
      email: `cap-${seq}@example.com`,
      phone: `+2348066${String(100_000 + seq).padStart(6, '0')}`,
      username: `cap_user_${seq}`,
      kycTier: tier,
    });
  }

  function fund(userId: string, amount: number, reference: string) {
    return request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount, reference });
  }

  function exposure(userId: string) {
    return ctx.dataSource.transaction((manager) =>
      ctx.ledgerService.getBalanceAndPendingFunding(manager, userId),
    );
  }

  async function completeViaWebhook(reference: string, netKobo: number) {
    const data = {
      reference,
      status: 'success',
      amount: (netKobo / 100).toFixed(2),
      fee: 0,
    };
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set(
        'x-korapay-signature',
        createHmac('sha256', FAKE_SECRET_KEY)
          .update(JSON.stringify(data))
          .digest('hex'),
      )
      .send(JSON.stringify({ event: 'charge.success', data }))
      .expect(200);
  }

  describe('ledger.getBalanceAndPendingFunding', () => {
    it('returns the cached balance and sums only the wallet’s own pending fundings', async () => {
      const user = await seedUser();
      const other = await seedUser();
      await fund(user.userId, 1_000_000, 'cliqpay-cap-read-1').expect(201);
      await fund(user.userId, 2_000_000, 'cliqpay-cap-read-2').expect(201);
      await fund(other.userId, 7_000_000, 'cliqpay-cap-read-other').expect(201);

      expect(await exposure(user.userId)).toEqual({
        balance: Money.zero('NGN'),
        pending: Money.of(3_000_000, 'NGN'),
      });
    });

    it('does not count failed or completed fundings; completed ones show up in the balance', async () => {
      const user = await seedUser();
      await fund(user.userId, 1_000_000, 'cliqpay-cap-read-done').expect(201);
      await fund(user.userId, 2_000_000, 'cliqpay-cap-read-kfail').expect(500);
      await fund(user.userId, 4_000_000, 'cliqpay-cap-read-live').expect(201);
      await completeViaWebhook('cliqpay-cap-read-done', 1_000_000);

      expect(await exposure(user.userId)).toEqual({
        balance: Money.of(1_000_000, 'NGN'),
        pending: Money.of(4_000_000, 'NGN'),
      });
    });

    it('does not count pending transactions of other types into the wallet', async () => {
      const user = await seedUser();
      await ctx.transactionRepo.save(
        ctx.transactionRepo.create({
          reference: 'cliqpay-cap-read-xfer',
          provider: null,
          providerReference: null,
          type: 'p2p_transfer',
          status: 'pending',
          reversesTransactionId: null,
          amount: 5_000_000n,
          currency: 'NGN',
          senderWalletId: null,
          recipientWalletId: user.walletId,
          metadata: {},
        }),
      );

      expect((await exposure(user.userId)).pending).toEqual(Money.zero('NGN'));
    });
  });

  it('allows an initiation that lands exactly on the cap', async () => {
    const user = await seedUser();

    await fund(user.userId, TIER1_CAP, 'cliqpay-cap-exact-1').expect(201);
  });

  it('rejects over the cap with a 422, never calls Kora and leaves no pending row', async () => {
    const user = await seedUser();
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    await fund(user.userId, TIER1_CAP + 1, 'cliqpay-cap-over-1').expect(422);
    const error = await ctx.paymentsService
      .fundWallet(user.userId, {
        amount: TIER1_CAP + 1,
        reference: 'cliqpay-cap-over-2',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BalanceCapExceededException);
    expect((error as BalanceCapExceededException).details).toEqual({
      balanceCap: { amount: String(TIER1_CAP), currency: 'NGN' },
      remaining: { amount: String(TIER1_CAP), currency: 'NGN' },
    });
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore);
    expect(
      await ctx.transactionRepo.findBy({ reference: 'cliqpay-cap-over-1' }),
    ).toHaveLength(0);
    expect(
      await ctx.transactionRepo.findBy({ reference: 'cliqpay-cap-over-2' }),
    ).toHaveLength(0);
  });

  it('holds a funding initiation back while another transaction holds the user lock', async () => {
    const user = await seedUser();
    const held = await holdUserLock(ctx.dataSource, user.userId);

    const call = trackSettled(fund(user.userId, 10_000, 'cliqpay-cap-lock-1'));
    await waitBriefly();
    const settledWhileHeld = call.isSettled();

    await held.release();
    const res = await call.promise;
    expect(settledWhileHeld).toBe(false);
    expect(res.status).toBe(201);
  });

  it('rejects any funding for tier 0 and never caps tier 3', async () => {
    const tier0 = await seedUser('tier0');
    const tier3 = await seedUser('tier3');

    const res = await fund(tier0.userId, 10_000, 'cliqpay-cap-tier0-1').expect(
      422,
    );
    expect(JSON.stringify(res.body)).toContain('Verify your BVN or NIN');
    await fund(tier3.userId, TIER1_CAP * 10, 'cliqpay-cap-tier3-1').expect(201);
  });

  it('rejects the second of two unpaid initiations that are each under the cap but jointly over it', async () => {
    const user = await seedUser();
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    await fund(user.userId, 20_000_000, 'cliqpay-cap-seq-1').expect(201);
    const second = await fund(user.userId, 10_000_001, 'cliqpay-cap-seq-2');

    expect(second.status).toBe(422);
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);
    await fund(user.userId, 10_000_000, 'cliqpay-cap-seq-3').expect(201);
  });

  it('lets exactly the concurrent initiations that fit succeed, with no overshoot', async () => {
    for (let round = 0; round < 5; round += 1) {
      const user = await seedUser();
      const initiatedBefore = ctx.fakeAdapter.initiated.length;

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          ctx.paymentsService.fundWallet(user.userId, {
            amount: 10_000_000,
            reference: `cliqpay-cap-conc-${round}-${i}`,
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(succeeded).toHaveLength(3);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(BalanceCapExceededException);
      }
      expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 3);
      expect((await exposure(user.userId)).pending).toEqual(
        Money.of(30_000_000, 'NGN'),
      );
    }
  });

  it('releases the headroom when the Kora call fails after the pending row is committed', async () => {
    const user = await seedUser();

    await fund(user.userId, TIER1_CAP, 'cliqpay-cap-kfail-1').expect(500);
    const failed = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-cap-kfail-1',
    });
    expect(failed.status).toBe('failed');

    await fund(user.userId, TIER1_CAP, 'cliqpay-cap-after-ok').expect(201);
  });

  it('lets a replayed reference return the original result without tripping or consuming the cap', async () => {
    const user = await seedUser();
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    const first = await fund(user.userId, TIER1_CAP, 'cliqpay-cap-replay-1');
    const replay = await fund(user.userId, TIER1_CAP, 'cliqpay-cap-replay-1');

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);
    expect((await exposure(user.userId)).pending).toEqual(
      Money.of(TIER1_CAP, 'NGN'),
    );
  });

  it('answers concurrent duplicates of a cap-filling reference with the original, never a cap error', async () => {
    const user = await seedUser();
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        ctx.paymentsService.fundWallet(user.userId, {
          amount: TIER1_CAP,
          reference: 'cliqpay-cap-dup-1',
        }),
      ),
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).not.toBeInstanceOf(BalanceCapExceededException);
      }
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);
    expect(
      await ctx.transactionRepo.findBy({ reference: 'cliqpay-cap-dup-1' }),
    ).toHaveLength(1);
  });

  it('counts a funding completed by webhook through the balance, once', async () => {
    const user = await seedUser();

    await fund(user.userId, 20_000_000, 'cliqpay-cap-done-1').expect(201);
    await completeViaWebhook('cliqpay-cap-done-1', 20_000_000);

    expect(await exposure(user.userId)).toEqual({
      balance: Money.of(20_000_000, 'NGN'),
      pending: Money.zero('NGN'),
    });
    await fund(user.userId, 10_000_001, 'cliqpay-cap-done-over').expect(422);
    await fund(user.userId, 10_000_000, 'cliqpay-cap-done-fit').expect(201);
  });
});
