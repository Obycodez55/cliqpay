import { IsNull } from 'typeorm';
import { AccountRestriction } from '../../src/modules/users/entities/account-restriction.entity';
import {
  SCAM_CASES_DUE_EVENT,
  SCAM_CASE_RESOLVED_EVENT,
} from '../../src/shared/events/domain-events';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { dataOf, errorOf } from './support/api-response';
import { assertInvariantHolds } from './support/ledger-invariant';
import {
  RiskTestContext,
  RiskUser,
  destroyRiskTestContext,
  payoutsFor,
  statusOf,
  withdraw,
} from './support/risk-test-context';
import {
  createScamHelpers,
  createScamTestContext,
} from './support/scam-test-context';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';
import { waitFor } from './support/social-blocks-test-helpers';

jest.setTimeout(180_000);

describe('scam case resolution', () => {
  let ctx: RiskTestContext;
  const h = createScamHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createScamTestContext();
  });

  afterAll(async () => {
    await destroyRiskTestContext(ctx);
  });

  const auditFor = (action: string, subjectId: string) =>
    ctx.auditRepo.findBy({ action, subjectId });

  async function openCase(options: {
    reporterBalance?: bigint;
    recipient?: RiskUser;
    reporter?: RiskUser;
    amount?: number;
  }) {
    const reporter =
      options.reporter ?? (await h.seed(options.reporterBalance ?? 5_000_000n));
    const recipient = options.recipient ?? (await h.seed(1_000_000n));
    const transactionId = await h.send(
      reporter,
      recipient,
      options.amount ?? 2_000_000,
    );
    const { reference } = await h.fileReport(reporter, transactionId);
    return { reporter, recipient, reference, transactionId };
  }

  describe('upheld', () => {
    it('pays the held amount to the reporter, confirms the flag, restricts the recipient and audits it', async () => {
      const { reporter, recipient, reference } = await openCase({});
      const reporterBefore = await h.balanceOf(reporter);
      const holdBefore = await h.fraudHoldBalance();

      const res = await h.resolve(reference, 'upheld').expect(200);

      expect(dataOf<{ status: string }>(res).status).toBe('upheld');
      expect(await h.balanceOf(reporter)).toBe(reporterBefore + 2_000_000n);
      expect(await h.balanceOf(recipient)).toBe(1_000_000n);
      expect(await h.fraudHoldBalance()).toBe(holdBefore - 2_000_000n);
      await assertInvariantHolds(ctx.accountRepo);

      const scamCase = await h.caseOf(reference);
      expect(scamCase).toMatchObject({
        status: 'upheld',
        heldAmount: 2_000_000n,
        recoveredAmount: 2_000_000n,
        decidedBy: 'reviewer-scam-1',
        decisionReason: 'Reviewed the evidence.',
      });
      const recovery = await ctx.transactionRepo.findOneByOrFail({
        reference: `${reference}-recovery`,
      });
      expect(recovery).toMatchObject({
        type: 'scam_recovery',
        status: 'completed',
        amount: 2_000_000n,
        recipientWalletId: reporter.walletId,
      });
      const hold = await ctx.transactionRepo.findOneByOrFail({
        reference: `${reference}-hold`,
      });
      expect(recovery.reversesTransactionId).toBe(hold.id);

      const [flag] = await h.openScamFlags(recipient);
      expect(flag).toMatchObject({
        status: 'confirmed',
        reviewedBy: 'reviewer-scam-1',
      });
      expect(await h.openRestrictions(recipient)).toEqual([
        expect.objectContaining({ scope: 'outbound', sourceId: scamCase.id }),
      ]);
      const [audit] = await auditFor('scam_case_resolved', scamCase.id);
      expect(audit).toMatchObject({
        actorType: 'reviewer',
        actorId: 'reviewer-scam-1',
      });
      expect(audit.metadata).toMatchObject({
        outcome: 'upheld',
        recovered: '2000000',
        transactionId: recovery.id,
      });
    });

    it('returns only what was held when the recipient had spent the rest', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(0n);
      const other = await h.seed();
      const transactionId = await h.send(reporter, recipient, 2_000_000);
      await h.send(recipient, other, 1_500_000);
      const { reference } = await h.fileReport(reporter, transactionId);
      const before = await h.balanceOf(reporter);

      await h.resolve(reference, 'upheld').expect(200);

      expect(await h.balanceOf(reporter)).toBe(before + 500_000n);
      const scamCase = await h.caseOf(reference);
      expect(scamCase.recoveredAmount).toBe(500_000n);
      expect(scamCase.reportedAmount).toBe(2_000_000n);
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('upholds a case with nothing held without posting', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(0n);
      const other = await h.seed();
      const transactionId = await h.send(reporter, recipient, 1_000_000);
      await h.send(recipient, other, 1_000_000);
      const { reference } = await h.fileReport(reporter, transactionId);

      await h.resolve(reference, 'upheld').expect(200);

      expect(
        await ctx.transactionRepo.findOneBy({
          reference: `${reference}-recovery`,
        }),
      ).toBeNull();
      expect((await h.openRestrictions(recipient)).length).toBe(1);
    });

    it('treats the recovery like a reversal: it is not received inflow and the balance cap does not stop it', async () => {
      const { reporter, reference } = await openCase({
        reporterBalance: 3_000_000n,
        amount: 2_000_000,
      });
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const receivedBefore = await ctx.ledgerService.getReceivedSince(
        ctx.dataSource.manager,
        reporter.userId,
        since,
      );
      const [{ cap }] = await ctx.dataSource.query<{ cap: string | null }[]>(
        `SELECT balance_cap_minor AS cap FROM tier_limits WHERE tier = 'tier3'`,
      );
      await ctx.dataSource.query(
        `UPDATE tier_limits SET balance_cap_minor = 1500000 WHERE tier = 'tier3'`,
      );

      try {
        await h.resolve(reference, 'upheld').expect(200);
      } finally {
        await ctx.dataSource.query(
          `UPDATE tier_limits SET balance_cap_minor = $1 WHERE tier = 'tier3'`,
          [cap],
        );
      }

      expect(await h.balanceOf(reporter)).toBe(3_000_000n);
      const receivedAfter = await ctx.ledgerService.getReceivedSince(
        ctx.dataSource.manager,
        reporter.userId,
        since,
      );
      expect(receivedAfter.amount).toBe(receivedBefore.amount);
    });

    it('tells both parties, and the reporter the amount back', async () => {
      const { reporter, recipient, reference } = await openCase({});
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await h.resolve(reference, 'upheld').expect(200);

      const events = (
        publish.mock.calls as [
          { name: string; payload: Record<string, unknown> },
        ][]
      )
        .map(([event]) => event)
        .filter((event) => event.name === SCAM_CASE_RESOLVED_EVENT);
      expect(events.map((e) => e.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: reporter.userId,
            party: 'reporter',
            outcome: 'upheld',
            amount: '20000.00',
          }),
          expect.objectContaining({
            userId: recipient.userId,
            party: 'recipient',
            outcome: 'upheld',
          }),
        ]),
      );
      publish.mockRestore();
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === reporter.email &&
            m.text.includes(reference) &&
            m.text.includes('was upheld'),
        ),
      );
    });
  });

  describe('rejected', () => {
    it('returns the held amount to the recipient, clears the flag and gives the reporter the reason', async () => {
      const { reporter, recipient, reference } = await openCase({});
      expect(await h.balanceOf(recipient)).toBe(1_000_000n);
      const holdBefore = await h.fraudHoldBalance();
      const reporterBefore = await h.balanceOf(reporter);

      await h
        .resolve(
          reference,
          'rejected',
          'The transfer matches an order you made.',
        )
        .expect(200);

      expect(await h.balanceOf(recipient)).toBe(3_000_000n);
      expect(await h.balanceOf(reporter)).toBe(reporterBefore);
      expect(await h.fraudHoldBalance()).toBe(holdBefore - 2_000_000n);
      await assertInvariantHolds(ctx.accountRepo);

      const release = await ctx.transactionRepo.findOneByOrFail({
        reference: `${reference}-release`,
      });
      expect(release).toMatchObject({
        type: 'fraud_hold_release',
        amount: 2_000_000n,
        recipientWalletId: recipient.walletId,
      });
      const [flag] = await h.openScamFlags(recipient);
      expect(flag.status).toBe('cleared');
      expect(await h.openRestrictions(recipient)).toHaveLength(0);

      const view = dataOf<
        {
          reference: string;
          decisionReason: string | null;
          recoveredAmount: { amount: string };
        }[]
      >(
        await h.http().get('/scam-reports').set(h.bearer(reporter)).expect(200),
      );
      expect(view.find((c) => c.reference === reference)).toMatchObject({
        decisionReason: 'The transfer matches an order you made.',
        recoveredAmount: { amount: '0' },
      });
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === reporter.email &&
            m.text.includes('not upheld') &&
            m.text.includes('matches an order you made'),
        ),
      );
    });

    it('lets the recipient withdraw again once the only case is rejected', async () => {
      const recipient = await h.seed(20_000_000n);
      const { reference } = await openCase({ recipient, amount: 1_000_000 });
      const held = await withdraw(ctx, recipient, 50_000);
      expect(await statusOf(ctx, held.reference)).toBe('under_review');

      await h.resolve(reference, 'rejected').expect(200);
      const after = await withdraw(ctx, recipient, 50_000);

      expect(await statusOf(ctx, after.reference)).toBe('pending');
      expect(payoutsFor(ctx, after.reference)).toHaveLength(1);
    });
  });

  describe('withdrawn', () => {
    it('releases the hold like a rejection, only for the reporter and only before a decision', async () => {
      const { reporter, recipient, reference } = await openCase({});
      const stranger = await h.seed();

      await h.withdraw(stranger, reference).expect(404);
      await h.withdraw(recipient, reference).expect(404);
      const res = await h.withdraw(reporter, reference).expect(200);

      expect(dataOf<{ status: string }>(res).status).toBe('withdrawn');
      expect(await h.balanceOf(recipient)).toBe(3_000_000n);
      const [flag] = await h.openScamFlags(recipient);
      expect(flag.status).toBe('cleared');
      await assertInvariantHolds(ctx.accountRepo);
      const scamCase = await h.caseOf(reference);
      expect(scamCase).toMatchObject({
        status: 'withdrawn',
        recoveredAmount: 0n,
      });
      expect(await auditFor('scam_report_withdrawn', scamCase.id)).toHaveLength(
        1,
      );

      const again = await h.withdraw(reporter, reference).expect(409);
      expect(errorOf(again).code).toBe('SCAM_CASE_ALREADY_DECIDED');
    });
  });

  describe('a decided case is final', () => {
    it.each(['upheld', 'rejected'] as const)(
      'refuses to decide a %s case again and moves no money',
      async (outcome) => {
        const { reporter, recipient, reference } = await openCase({});
        await h.resolve(reference, outcome).expect(200);
        const reporterBalance = await h.balanceOf(reporter);
        const recipientBalance = await h.balanceOf(recipient);
        const holdBalance = await h.fraudHoldBalance();

        for (const next of ['upheld', 'rejected'] as const) {
          const res = await h.resolve(reference, next).expect(409);
          expect(errorOf(res).code).toBe('SCAM_CASE_ALREADY_DECIDED');
        }
        await h.withdraw(reporter, reference).expect(409);

        expect(await h.balanceOf(reporter)).toBe(reporterBalance);
        expect(await h.balanceOf(recipient)).toBe(recipientBalance);
        expect(await h.fraudHoldBalance()).toBe(holdBalance);
        expect((await h.caseOf(reference)).status).toBe(outcome);
      },
    );

    it('lets the same transfer start no new case, but a new transfer starts a new one', async () => {
      const { reporter, recipient, reference, transactionId } = await openCase(
        {},
      );
      await h.resolve(reference, 'rejected').expect(200);

      await h.report(reporter, transactionId).expect(409);
      const fresh = await h.send(reporter, recipient, 100_000);
      await h.report(reporter, fresh).expect(201);
    });

    it('runs two concurrent decisions to one winner', async () => {
      const { reporter, reference } = await openCase({});
      const before = await h.balanceOf(reporter);

      const results = await Promise.all([
        h.resolve(reference, 'upheld'),
        h.resolve(reference, 'rejected'),
        h.withdraw(reporter, reference),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      const scamCase = await h.caseOf(reference);
      expect(scamCase.status).not.toBe('open');
      expect(await h.balanceOf(reporter)).toBe(
        before + scamCase.recoveredAmount,
      );
      await assertInvariantHolds(ctx.accountRepo);
    });
  });

  describe('several open cases against one recipient', () => {
    it('keeps the flag open and the withdrawals held until the last open case is closed', async () => {
      const recipient = await h.seed(20_000_000n);
      const first = await openCase({ recipient, amount: 500_000 });
      const second = await openCase({ recipient, amount: 500_000 });
      const [flag] = await h.openScamFlags(recipient);
      expect(flag.hitCount).toBe(2);

      await h.resolve(first.reference, 'rejected').expect(200);

      expect((await h.openScamFlags(recipient))[0].status).toBe('open');
      const held = await withdraw(ctx, recipient, 50_000);
      expect(await statusOf(ctx, held.reference)).toBe('under_review');

      await h.withdraw(second.reporter, second.reference).expect(200);

      expect((await h.openScamFlags(recipient))[0].status).toBe('cleared');
      const free = await withdraw(ctx, recipient, 50_000);
      expect(await statusOf(ctx, free.reference)).toBe('pending');
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('lifts the pending restriction when the remaining open cases are from one reporter', async () => {
      const recipient = await h.seed(20_000_000n);
      const first = await openCase({ recipient, amount: 300_000 });
      const second = await openCase({ recipient, amount: 300_000 });
      const third = await openCase({
        recipient,
        amount: 300_000,
        reporter: first.reporter,
      });
      expect(await h.openRestrictions(recipient)).not.toHaveLength(0);

      await h.resolve(second.reference, 'rejected').expect(200);

      expect(await h.openRestrictions(recipient)).toHaveLength(0);
      expect((await h.openScamFlags(recipient))[0].status).toBe('open');
      expect((await h.caseOf(third.reference)).status).toBe('open');
      const lifted = await ctx.auditRepo.findBy({
        action: 'restriction_lifted',
      });
      expect(lifted.some((e) => e.subjectId === recipient.userId)).toBe(true);
    });

    it('keeps the pending restriction while two distinct reporters still have open cases', async () => {
      const recipient = await h.seed(20_000_000n);
      const first = await openCase({ recipient, amount: 300_000 });
      const second = await openCase({ recipient, amount: 300_000 });
      const third = await openCase({ recipient, amount: 300_000 });

      await h.resolve(first.reference, 'rejected').expect(200);

      const restrictions = await h.openRestrictions(recipient);
      expect(restrictions.length).toBeGreaterThan(0);
      expect((await h.openScamFlags(recipient))[0].status).toBe('open');

      await h.withdraw(second.reporter, second.reference).expect(200);
      await h.withdraw(third.reporter, third.reference).expect(200);

      expect(await h.openRestrictions(recipient)).toHaveLength(0);
      expect((await h.openScamFlags(recipient))[0].status).toBe('cleared');
    });

    it('keeps the restriction of an upheld case when others are rejected', async () => {
      const recipient = await h.seed(20_000_000n);
      const first = await openCase({ recipient, amount: 300_000 });
      const second = await openCase({ recipient, amount: 300_000 });

      await h.resolve(second.reference, 'upheld').expect(200);
      await h.resolve(first.reference, 'rejected').expect(200);

      const [restriction] = await h.openRestrictions(recipient);
      expect(restriction.sourceId).toBe((await h.caseOf(second.reference)).id);
      expect(
        await ctx.dataSource
          .getRepository(AccountRestriction)
          .countBy({ userId: recipient.userId, liftedAt: IsNull() }),
      ).toBe(1);
    });
  });

  describe('reviewer endpoints', () => {
    const routes: [string, string][] = [
      ['get', '/internal/risk/scam-cases'],
      ['get', '/internal/risk/scam-cases/SCM-000001'],
      ['post', '/internal/risk/scam-cases/SCM-000001/resolve'],
    ];

    it.each(routes)(
      '%s %s refuses a request without the secret',
      async (method, path) => {
        const res = await h
          .http()
          [method as 'get' | 'post'](path)
          .set('X-Reviewer-Id', 'someone')
          .send({ outcome: 'upheld', reason: 'x' });
        expect(res.status).toBe(401);
      },
    );

    it.each(routes)(
      '%s %s refuses a request without a reviewer id',
      async (method, path) => {
        const res = await h
          .http()
          [method as 'get' | 'post'](path)
          .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
          .send({ outcome: 'upheld', reason: 'x' });
        expect(res.status).toBe(401);
      },
    );

    it('changes nothing when refused', async () => {
      const { reporter, reference } = await openCase({});
      const before = await h.balanceOf(reporter);

      await h
        .http()
        .post(`/internal/risk/scam-cases/${reference}/resolve`)
        .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
        .send({ outcome: 'upheld', reason: 'x' })
        .expect(401);

      expect((await h.caseOf(reference)).status).toBe('open');
      expect(await h.balanceOf(reporter)).toBe(before);
      expect(
        await auditFor('scam_case_resolved', (await h.caseOf(reference)).id),
      ).toHaveLength(0);
    });

    it('rejects an invalid resolution and an unknown case', async () => {
      const { reference } = await openCase({});

      await h
        .reviewer(
          h.http().post(`/internal/risk/scam-cases/${reference}/resolve`),
        )
        .send({ outcome: 'withdrawn', reason: 'x' })
        .expect(400);
      await h
        .reviewer(
          h.http().post(`/internal/risk/scam-cases/${reference}/resolve`),
        )
        .send({ outcome: 'upheld' })
        .expect(400);
      await h
        .reviewer(h.http().post('/internal/risk/scam-cases/SCM-999999/resolve'))
        .send({ outcome: 'upheld', reason: 'x' })
        .expect(404);
      await h
        .reviewer(h.http().get('/internal/risk/scam-cases/SCM-999999'))
        .expect(404);
      expect((await h.caseOf(reference)).status).toBe('open');
    });

    it('lists by status and overdue, and reads a case with the recipient’s response', async () => {
      const open = await openCase({ amount: 100_000 });
      const decided = await openCase({ amount: 100_000 });
      const overdue = await openCase({ amount: 100_000 });
      await h.resolve(decided.reference, 'rejected').expect(200);
      await ctx.dataSource.query(
        `UPDATE scam_cases SET due_at = now() - interval '1 day' WHERE reference = $1`,
        [overdue.reference],
      );
      await h
        .http()
        .post(`/scam-reports/${open.reference}/response`)
        .set(h.bearer(open.recipient))
        .send({ response: 'This was for a laptop.' })
        .expect(204);
      const list = async (query: string) =>
        dataOf<{ reference: string }[]>(
          await h
            .reviewer(h.http().get(`/internal/risk/scam-cases${query}`))
            .expect(200),
        ).map((c) => c.reference);

      expect(await list('?status=rejected')).toContain(decided.reference);
      expect(await list('?status=rejected')).not.toContain(open.reference);
      const overdueRefs = await list('?overdue=true');
      expect(overdueRefs).toContain(overdue.reference);
      expect(overdueRefs).not.toContain(open.reference);
      expect(overdueRefs).not.toContain(decided.reference);

      const read = dataOf<Record<string, unknown>>(
        await h
          .reviewer(h.http().get(`/internal/risk/scam-cases/${open.reference}`))
          .expect(200),
      );
      expect(read).toMatchObject({
        reference: open.reference,
        recipientResponse: 'This was for a laptop.',
        category: 'impersonation',
        heldAmount: { amount: '100000', currency: 'NGN' },
        reimbursedAmount: null,
      });
    });
  });

  describe('ops alerts', () => {
    const dueEvents = (publish: jest.SpyInstance) =>
      publish.mock.calls
        .map(
          ([event]) =>
            event as { name: string; payload: Record<string, unknown> },
        )
        .filter((event) => event.name === SCAM_CASES_DUE_EVENT);

    it('alerts when a case is within two working days of its due date and closes nothing', async () => {
      await ctx.dataSource.query(
        `UPDATE scam_cases SET status = 'withdrawn' WHERE status = 'open'`,
      );
      const near = await openCase({ amount: 100_000 });
      const far = await openCase({ amount: 100_000 });
      await ctx.dataSource.query(
        `UPDATE scam_cases SET due_at = now() + interval '1 day' WHERE reference = $1`,
        [near.reference],
      );
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await h.scamCases().alertCasesDue();

      const [event] = dueEvents(publish);
      expect(event.payload).toMatchObject({
        email: 'ops@cliqpay.test',
        dueSoon: 1,
        overdue: 0,
        caseReferences: [near.reference],
      });
      expect((await h.caseOf(near.reference)).status).toBe('open');
      expect((await h.caseOf(far.reference)).status).toBe('open');
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === 'ops@cliqpay.test' &&
            /Scam cases due/.test(m.subject) &&
            m.text.includes(near.reference),
        ),
      );
      publish.mockRestore();
    });

    it('counts overdue cases and repeats until they are closed', async () => {
      await ctx.dataSource.query(
        `UPDATE scam_cases SET status = 'withdrawn' WHERE status = 'open'`,
      );
      const late = await openCase({ amount: 100_000 });
      await ctx.dataSource.query(
        `UPDATE scam_cases SET due_at = now() - interval '3 days' WHERE reference = $1`,
        [late.reference],
      );
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await h.scamCases().alertCasesDue();
      await h.scamCases().alertCasesDue();

      expect(dueEvents(publish)).toHaveLength(2);
      expect(dueEvents(publish)[0].payload).toMatchObject({ overdue: 1 });
      expect((await h.caseOf(late.reference)).status).toBe('open');
      publish.mockRestore();
    });

    it('stays quiet when no case is near its due date', async () => {
      await ctx.dataSource.query(
        `UPDATE scam_cases SET status = 'withdrawn' WHERE status = 'open'`,
      );
      await openCase({ amount: 100_000 });
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

      await h.scamCases().alertCasesDue();

      expect(dueEvents(publish)).toHaveLength(0);
      publish.mockRestore();
    });
  });

  describe('reviewing the scam_report flag', () => {
    const review = (flagId: string, status: string) =>
      h
        .reviewer(h.http().post(`/internal/risk/flags/${flagId}/review`))
        .send({ status });

    it('refuses to clear the flag while the user still has an open case, and allows it once none is open', async () => {
      const { recipient, reference } = await openCase({});
      const [flag] = await h.openScamFlags(recipient);

      const refused = await review(flag.id, 'cleared');

      expect(refused.status).toBe(409);
      expect(errorOf(refused).code).toBe('FRAUD_FLAG_HAS_OPEN_SCAM_CASES');
      const after = await ctx.flagRepo.findOneByOrFail({ id: flag.id });
      expect(after.status).toBe('open');

      await ctx.dataSource.query(
        `UPDATE scam_cases SET status = 'withdrawn' WHERE reference = $1`,
        [reference],
      );
      await review(flag.id, 'cleared').expect(201);
    });
  });
});
