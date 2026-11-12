import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { AccountRestriction } from '../../src/modules/users/entities/account-restriction.entity';
import { Money } from '../../src/shared/primitives/money';
import { RISK_REVIEW_OVERDUE_EVENT } from '../../src/shared/events/domain-events';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { WITHDRAWAL_UNDER_REVIEW_MESSAGE } from '../../src/modules/withdrawals/withdrawals.service';
import { dataOf, errorOf } from './support/api-response';
import { assertInvariantHolds } from './support/ledger-invariant';
import { addTestRestriction } from './support/restrictions';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';
import { waitFor } from './support/social-blocks-test-helpers';
import {
  RiskTestContext,
  RiskUser,
  createRiskTestContext,
  destroyRiskTestContext,
  insertFlag,
  payoutsFor,
  seedRiskUser,
  sendP2p,
  statusOf,
  withdraw,
} from './support/risk-test-context';

jest.setTimeout(180_000);

const REVIEWER = 'reviewer-risk-1';

describe('risk review endpoints', () => {
  let ctx: RiskTestContext;

  beforeAll(async () => {
    ctx = await createRiskTestContext();
  });

  afterAll(async () => {
    await destroyRiskTestContext(ctx);
  });

  const server = () => ctx.app.getHttpServer();
  const authed = (req: request.Test) =>
    req
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .set('X-Reviewer-Id', REVIEWER);
  const get = (path: string) => authed(request(server()).get(path));
  const post = (path: string, body: object = {}) =>
    authed(request(server()).post(path)).send(body);

  const auditFor = (action: string, subjectId: string) =>
    ctx.auditRepo.findBy({ action, subjectId });

  async function heldWithdrawal(options: { reference?: string } = {}) {
    const user = await seedRiskUser(ctx, {
      balanceMinor: 12_000_000n,
      ageDays: 1,
    });
    const { reference } = await withdraw(
      ctx,
      user,
      10_000_000,
      options.reference,
    );
    expect(await statusOf(ctx, reference)).toBe('under_review');
    return { user, reference };
  }

  const balanceOf = async (user: RiskUser) =>
    (await ctx.accountRepo.findOneByOrFail({ id: user.walletId })).balance;

  describe('access', () => {
    const routes: [string, string][] = [
      ['get', '/internal/risk/flags'],
      ['get', '/internal/risk/flags/shadow'],
      ['get', '/internal/risk/flags/00000000-0000-4000-8000-000000000000'],
      [
        'post',
        '/internal/risk/flags/00000000-0000-4000-8000-000000000000/review',
      ],
      ['post', '/internal/risk/restrictions/lift'],
      ['get', '/internal/risk/withdrawals'],
      ['post', '/internal/risk/withdrawals/some-ref/release'],
      ['post', '/internal/risk/withdrawals/some-ref/reject'],
    ];

    it.each(routes)(
      '%s %s refuses a request without the internal secret',
      async (method, path) => {
        const res = await request(server())
          [method as 'get' | 'post'](path)
          .set('X-Reviewer-Id', REVIEWER)
          .send({});
        expect(res.status).toBe(401);
      },
    );

    it.each(routes)(
      '%s %s refuses a request without a reviewer id',
      async (method, path) => {
        const res = await request(server())
          [method as 'get' | 'post'](path)
          .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
          .send({});
        expect(res.status).toBe(401);
      },
    );

    it('makes no change when the reviewer id is missing', async () => {
      const user = await seedRiskUser(ctx);
      const flag = await insertFlag(ctx, user.userId);

      await request(server())
        .post(`/internal/risk/flags/${flag.id}/review`)
        .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
        .send({ status: 'confirmed' })
        .expect(401);

      expect((await ctx.flagRepo.findOneByOrFail({ id: flag.id })).status).toBe(
        'open',
      );
      expect(await auditFor('fraud_flag_reviewed', flag.id)).toHaveLength(0);
    });
  });

  describe('listing and reading flags', () => {
    it('lists enforced flags and shadow flags separately', async () => {
      const user = await seedRiskUser(ctx);
      const enforced = await insertFlag(ctx, user.userId, {
        ruleCode: 'mule_fan_in',
      });
      const shadow = await insertFlag(ctx, user.userId, {
        ruleCode: 'send_burst',
        enforced: false,
      });

      const main = dataOf<{ id: string }[]>(
        await get(`/internal/risk/flags?userId=${user.userId}`).expect(200),
      );
      const shadows = dataOf<{ id: string }[]>(
        await get(`/internal/risk/flags/shadow?userId=${user.userId}`).expect(
          200,
        ),
      );

      expect(main.map((f) => f.id)).toEqual([enforced.id]);
      expect(shadows.map((f) => f.id)).toEqual([shadow.id]);
    });

    it('filters by status and reads one flag with its evidence', async () => {
      const user = await seedRiskUser(ctx);
      const flag = await insertFlag(ctx, user.userId);

      const open = dataOf<{ id: string }[]>(
        await get(
          `/internal/risk/flags?userId=${user.userId}&status=cleared`,
        ).expect(200),
      );
      const one = dataOf<{ id: string; evidence: unknown[]; hitCount: number }>(
        await get(`/internal/risk/flags/${flag.id}`).expect(200),
      );

      expect(open).toEqual([]);
      expect(one).toMatchObject({
        id: flag.id,
        hitCount: 1,
        evidence: [{ seeded: true }],
      });
    });

    it('answers 404 for an unknown flag', async () => {
      const res = await get(
        '/internal/risk/flags/00000000-0000-4000-8000-000000000000',
      );
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('FRAUD_FLAG_NOT_FOUND');
    });
  });

  describe('reviewing a flag', () => {
    it('moves open to reviewing, then cleared, recording the reviewer and an audit event each time', async () => {
      const user = await seedRiskUser(ctx);
      const flag = await insertFlag(ctx, user.userId);

      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'reviewing',
      }).expect(201);
      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'cleared',
        note: 'known seller',
      }).expect(201);

      const stored = await ctx.flagRepo.findOneByOrFail({ id: flag.id });
      expect(stored).toMatchObject({
        status: 'cleared',
        reviewedBy: REVIEWER,
        reviewNote: 'known seller',
      });
      expect(stored.reviewedAt).not.toBeNull();
      const events = await auditFor('fraud_flag_reviewed', flag.id);
      expect(events).toHaveLength(2);
      expect(
        events.every(
          (e) => e.actorType === 'reviewer' && e.actorId === REVIEWER,
        ),
      ).toBe(true);
      expect(events.map((e) => e.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'open', to: 'reviewing' }),
          expect.objectContaining({
            from: 'reviewing',
            to: 'cleared',
            note: 'known seller',
          }),
        ]),
      );
    });

    it('confirming adds a fraud restriction on outbound money, audited, and blocks P2P sends and withdrawals', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      const friend = await seedRiskUser(ctx, {
        balanceMinor: 500_000n,
        ageDays: 30,
      });
      const flag = await insertFlag(ctx, user.userId);

      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'confirmed',
        note: 'mule',
      }).expect(201);

      const restrictions = await ctx.dataSource
        .getRepository(AccountRestriction)
        .findBy({ userId: user.userId, liftedAt: IsNull() });
      expect(restrictions).toHaveLength(1);
      expect(restrictions[0]).toMatchObject({
        reason: 'fraud',
        scope: 'outbound',
        sourceId: flag.id,
      });
      const added = await ctx.auditRepo.findBy({
        action: 'restriction_added',
        subjectId: user.userId,
      });
      expect(added[0]).toMatchObject({
        actorType: 'reviewer',
        actorId: REVIEWER,
      });
      await expect(sendP2p(ctx, user, friend, 100_000)).rejects.toThrow();
      await expect(withdraw(ctx, user, 100_000)).rejects.toMatchObject({
        code: 'INITIATOR_ACCOUNT_FROZEN',
      });
      await sendP2p(ctx, friend, user, 100_000);
    });

    it('does not release held withdrawals when a flag is cleared', async () => {
      const { user, reference } = await heldWithdrawal();
      const flag = await ctx.flagRepo.findOneByOrFail({
        userId: user.userId,
        status: 'open',
      });

      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'cleared',
      }).expect(201);

      expect(await statusOf(ctx, reference)).toBe('under_review');
      expect(payoutsFor(ctx, reference)).toHaveLength(0);
    });

    it('refuses a move out of a resolved status and from reviewing back to reviewing', async () => {
      const user = await seedRiskUser(ctx);
      const flag = await insertFlag(ctx, user.userId);
      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'reviewing',
      }).expect(201);

      const again = await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'reviewing',
      });
      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'confirmed',
      }).expect(201);
      const afterConfirm = await post(
        `/internal/risk/flags/${flag.id}/review`,
        {
          status: 'cleared',
        },
      );

      expect(again.status).toBe(409);
      expect(afterConfirm.status).toBe(409);
      expect(errorOf(afterConfirm).code).toBe('FRAUD_FLAG_ALREADY_RESOLVED');
    });

    it('rejects a status that is not a review outcome', async () => {
      const user = await seedRiskUser(ctx);
      const flag = await insertFlag(ctx, user.userId);

      await post(`/internal/risk/flags/${flag.id}/review`, {
        status: 'open',
      }).expect(400);
    });
  });

  describe('lifting a restriction', () => {
    it('lifts a fraud restriction, audited under the reviewer', async () => {
      const user = await seedRiskUser(ctx);
      const sourceId = await addTestRestriction(ctx.dataSource, user.userId, {
        reason: 'fraud',
      });

      await post('/internal/risk/restrictions/lift', {
        userId: user.userId,
        reason: 'fraud',
        sourceId,
      }).expect(204);

      expect(
        await ctx.dataSource
          .getRepository(AccountRestriction)
          .existsBy({ userId: user.userId, liftedAt: IsNull() }),
      ).toBe(false);
      const [event] = await ctx.auditRepo.findBy({
        action: 'restriction_lifted',
        subjectId: user.userId,
      });
      expect(event).toMatchObject({ actorType: 'reviewer', actorId: REVIEWER });
    });

    it.each(['dispute', 'sanctions', 'self_lock'] as const)(
      'refuses to lift a %s restriction',
      async (reason) => {
        const user = await seedRiskUser(ctx);
        const sourceId = await addTestRestriction(ctx.dataSource, user.userId, {
          reason,
        });

        const res = await post('/internal/risk/restrictions/lift', {
          userId: user.userId,
          reason,
          sourceId,
        });

        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('RESTRICTION_NOT_LIFTABLE');
        expect(
          await ctx.dataSource
            .getRepository(AccountRestriction)
            .existsBy({ userId: user.userId, liftedAt: IsNull() }),
        ).toBe(true);
      },
    );

    it('answers 404 when no open restriction matches', async () => {
      const user = await seedRiskUser(ctx);

      const res = await post('/internal/risk/restrictions/lift', {
        userId: user.userId,
        reason: 'fraud',
        sourceId: '00000000-0000-4000-8000-000000000000',
      });

      expect(res.status).toBe(404);
    });
  });

  describe('held withdrawals', () => {
    it('lists them oldest first with the amount and bank account', async () => {
      const { user, reference } = await heldWithdrawal();

      const list = dataOf<
        { reference: string; userId: string; amount: { amount: string } }[]
      >(
        await get(`/internal/risk/withdrawals?userId=${user.userId}`).expect(
          200,
        ),
      );

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ reference, userId: user.userId });
      expect(list[0].amount.amount).toBe('10000000');
    });

    describe('release', () => {
      it('sends the payout and continues as pending, audited', async () => {
        const { user, reference } = await heldWithdrawal();
        const before = await balanceOf(user);

        const res = await post(
          `/internal/risk/withdrawals/${reference}/release`,
        ).expect(201);

        expect(dataOf(res)).toEqual({ reference, status: 'pending' });
        expect(await statusOf(ctx, reference)).toBe('pending');
        expect(payoutsFor(ctx, reference)).toHaveLength(1);
        expect(await balanceOf(user)).toBe(before);
        const tx = await ctx.transactionRepo.findOneByOrFail({ reference });
        const [event] = await auditFor('withdrawal_released', tx.id);
        expect(event).toMatchObject({
          actorType: 'reviewer',
          actorId: REVIEWER,
        });
        expect(event.metadata).toMatchObject({
          reference,
          userId: user.userId,
        });
      });

      it('can complete afterwards like any pending withdrawal', async () => {
        const { reference } = await heldWithdrawal();
        await post(`/internal/risk/withdrawals/${reference}/release`).expect(
          201,
        );

        const result = await ctx.ledgerService.completeWithdrawal({
          reference,
          providerReportedAmount: await amountOf(reference),
        });

        expect(result).not.toBeNull();
        expect(await statusOf(ctx, reference)).toBe('completed');
      });

      it('refuses a second release, and a reject after a release', async () => {
        const { reference } = await heldWithdrawal();
        await post(`/internal/risk/withdrawals/${reference}/release`).expect(
          201,
        );

        const again = await post(
          `/internal/risk/withdrawals/${reference}/release`,
        );
        const reject = await post(
          `/internal/risk/withdrawals/${reference}/reject`,
        );

        expect(again.status).toBe(409);
        expect(reject.status).toBe(409);
        expect(errorOf(reject).code).toBe('WITHDRAWAL_NOT_UNDER_REVIEW');
        expect(payoutsFor(ctx, reference)).toHaveLength(1);
        expect(await statusOf(ctx, reference)).toBe('pending');
      });

      it('returns the money when Kora rejects the payout', async () => {
        const { user, reference } = await heldWithdrawal({
          reference: 'wd-reject-after-review',
        });

        const res = await post(
          `/internal/risk/withdrawals/${reference}/release`,
        );

        expect(res.status).toBe(422);
        expect(await statusOf(ctx, reference)).toBe('reversed');
        expect(await balanceOf(user)).toBe(12_000_000n);
        await assertInvariantHolds(ctx.accountRepo);
      });

      it.each(['self_lock', 'fraud', 'dispute'] as const)(
        'refuses to release while the owner has a %s restriction, and the reviewer can still reject',
        async (reason) => {
          const { user, reference } = await heldWithdrawal();
          await addTestRestriction(ctx.dataSource, user.userId, { reason });

          const res = await post(
            `/internal/risk/withdrawals/${reference}/release`,
          );

          expect(res.status).toBe(409);
          expect(errorOf(res).code).toBe('WITHDRAWAL_OWNER_RESTRICTED');
          expect(await statusOf(ctx, reference)).toBe('under_review');
          expect(payoutsFor(ctx, reference)).toHaveLength(0);

          await post(`/internal/risk/withdrawals/${reference}/reject`).expect(
            201,
          );
          expect(await balanceOf(user)).toBe(12_000_000n);
        },
      );

      it('answers 409 for a reference that is not under review', async () => {
        const res = await post(
          '/internal/risk/withdrawals/does-not-exist/release',
        );
        expect(res.status).toBe(409);
      });
    });

    describe('reject', () => {
      it('reverses the withdrawal, returns every kobo to the wallet and never calls Kora', async () => {
        const { user, reference } = await heldWithdrawal();
        expect(await balanceOf(user)).toBe(12_000_000n - 10_000_000n - 3_000n);

        const res = await post(
          `/internal/risk/withdrawals/${reference}/reject`,
          {
            note: 'confirmed mule',
          },
        ).expect(201);

        expect(dataOf(res)).toEqual({ reference, status: 'reversed' });
        expect(await statusOf(ctx, reference)).toBe('reversed');
        expect(await balanceOf(user)).toBe(12_000_000n);
        expect(payoutsFor(ctx, reference)).toHaveLength(0);
        const original = await ctx.transactionRepo.findOneByOrFail({
          reference,
        });
        const reversal = await ctx.transactionRepo.findOneByOrFail({
          reversesTransactionId: original.id,
        });
        expect(reversal.type).toBe('withdrawal_reversal');
        expect(
          await ctx.ledgerEntryRepo.countBy({ transactionId: reversal.id }),
        ).toBe(5);
        await assertInvariantHolds(ctx.accountRepo);
        const [event] = await auditFor('withdrawal_rejected', original.id);
        expect(event).toMatchObject({
          actorType: 'reviewer',
          actorId: REVIEWER,
        });
        expect(event.metadata).toMatchObject({
          reference,
          note: 'confirmed mule',
        });
      });

      it('tells the user only that it could not be completed', async () => {
        const { user, reference } = await heldWithdrawal();

        await post(`/internal/risk/withdrawals/${reference}/reject`, {
          note: 'internal detail',
        }).expect(201);

        await waitFor(() =>
          ctx.emailAdapter.sent.some(
            (m) => m.to === user.email && /withdrawal/i.test(m.subject),
          ),
        );
        const mail = ctx.emailAdapter.sent.find(
          (m) => m.to === user.email && /withdrawal/i.test(m.subject),
        )!;
        expect(mail.text).toContain('could not be completed');
        expect(mail.text).not.toMatch(/fraud|mule|review|internal detail/i);
      });

      it('says a replay of the rejected reference was reversed, not rejected by the provider', async () => {
        const { user, reference } = await heldWithdrawal();
        await post(`/internal/risk/withdrawals/${reference}/reject`).expect(
          201,
        );

        const replay = withdraw(ctx, user, 10_000_000, reference);

        await expect(replay).rejects.toThrow(/already reversed/);
        await expect(replay).rejects.not.toThrow(/provider/);
      });

      it('refuses a second reject and a release afterwards', async () => {
        const { user, reference } = await heldWithdrawal();
        await post(`/internal/risk/withdrawals/${reference}/reject`).expect(
          201,
        );

        const again = await post(
          `/internal/risk/withdrawals/${reference}/reject`,
        );
        const release = await post(
          `/internal/risk/withdrawals/${reference}/release`,
        );

        expect(again.status).toBe(409);
        expect(release.status).toBe(409);
        expect(await balanceOf(user)).toBe(12_000_000n);
      });

      it('refuses to reject a withdrawal that was already sent', async () => {
        const user = await seedRiskUser(ctx, {
          balanceMinor: 2_000_000n,
          ageDays: 30,
        });
        const { reference } = await withdraw(ctx, user, 100_000);

        const res = await post(
          `/internal/risk/withdrawals/${reference}/reject`,
        );

        expect(res.status).toBe(409);
        expect(await statusOf(ctx, reference)).toBe('pending');
      });
    });
  });

  async function amountOf(reference: string) {
    const tx = await ctx.transactionRepo.findOneByOrFail({ reference });
    return Money.of(tx.amount, tx.currency);
  }

  describe('overdue review alert', () => {
    const overdueEvents = (publish: jest.SpyInstance) =>
      publish.mock.calls
        .map(
          ([event]) =>
            event as { name: string; payload: Record<string, unknown> },
        )
        .filter((event) => event.name === RISK_REVIEW_OVERDUE_EVENT);

    it('alerts ops about an enforced flag and a held withdrawal past 24 hours, and resolves nothing', async () => {
      const { user, reference } = await heldWithdrawal();
      const flag = await ctx.flagRepo.findOneByOrFail({
        userId: user.userId,
        status: 'open',
      });
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await ctx.flagRepo.update({ id: flag.id }, { createdAt: old });
      await ctx.transactionRepo.update({ reference }, { createdAt: old });
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await ctx.riskService.alertOverdueReviews();

      const [event] = overdueEvents(publish);
      expect(event.payload).toMatchObject({ email: 'ops@cliqpay.test' });
      expect(event.payload.flagIds).toContain(flag.id);
      expect(event.payload.withdrawalReferences).toContain(reference);
      expect(event.payload.oldestHours as number).toBeGreaterThanOrEqual(24);
      expect((await ctx.flagRepo.findOneByOrFail({ id: flag.id })).status).toBe(
        'open',
      );
      expect(await statusOf(ctx, reference)).toBe('under_review');
      expect(payoutsFor(ctx, reference)).toHaveLength(0);
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === 'ops@cliqpay.test' &&
            /Risk reviews overdue/.test(m.subject),
        ),
      );
      publish.mockRestore();
    });

    it('stays quiet when nothing is past its target', async () => {
      await ctx.dataSource.query(
        `UPDATE fraud_flags SET status = 'cleared' WHERE status IN ('open', 'reviewing')`,
      );
      await ctx.dataSource.query(
        `UPDATE transactions SET status = 'reversed' WHERE status = 'under_review'`,
      );
      await heldWithdrawal();
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await ctx.riskService.alertOverdueReviews();

      expect(overdueEvents(publish)).toHaveLength(0);
      publish.mockRestore();
    });

    it('does not count shadow flags', async () => {
      await ctx.dataSource.query(
        `UPDATE fraud_flags SET status = 'cleared' WHERE status IN ('open', 'reviewing')`,
      );
      await ctx.dataSource.query(
        `UPDATE transactions SET status = 'reversed' WHERE status = 'under_review'`,
      );
      const user = await seedRiskUser(ctx);
      const shadow = await insertFlag(ctx, user.userId, {
        ruleCode: 'send_burst',
        enforced: false,
      });
      await ctx.flagRepo.update(
        { id: shadow.id },
        { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      );
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await ctx.riskService.alertOverdueReviews();

      expect(overdueEvents(publish)).toHaveLength(0);
      publish.mockRestore();
    });
  });

  it('keeps the same message for the user whatever the cause', () => {
    expect(WITHDRAWAL_UNDER_REVIEW_MESSAGE).toBe(
      'This withdrawal is being reviewed. This usually takes up to 24 hours.',
    );
  });
});
