import { MoneyRequestsService } from '../../src/modules/transfers/money-requests.service';
import { addWeekdays } from '../../src/modules/risk/internal/working-days';
import { dataOf, errorOf } from './support/api-response';
import { assertInvariantHolds } from './support/ledger-invariant';
import {
  RiskTestContext,
  destroyRiskTestContext,
  statusOf,
  withdraw,
} from './support/risk-test-context';
import {
  createScamHelpers,
  createScamTestContext,
} from './support/scam-test-context';
import { waitFor } from './support/social-blocks-test-helpers';

jest.setTimeout(180_000);

describe('scam reports', () => {
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

  describe('the hold', () => {
    it('holds the full amount from a recipient who still has it, acknowledges with a reference and a due date, and tells the recipient', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const transactionId = await h.send(reporter, recipient, 2_000_000);
      const before = await h.fraudHoldBalance();

      const res = await h
        .report(reporter, transactionId, { contactChannel: 'WhatsApp' })
        .expect(201);
      const body = dataOf<{
        reference: string;
        status: string;
        late: boolean;
        dueAt: string;
        reportedAmount: { amount: string; currency: string };
        nextSteps: string[];
      }>(res);

      expect(body.reference).toMatch(/^SCM-\d{6}$/);
      expect(body.status).toBe('open');
      expect(body.late).toBe(false);
      expect(body.reportedAmount).toEqual({
        amount: '2000000',
        currency: 'NGN',
      });
      expect(body.nextSteps.length).toBeGreaterThan(0);
      const due = new Date(body.dueAt).getTime();
      const expected = addWeekdays(new Date(), 14).getTime();
      expect(Math.abs(due - expected)).toBeLessThan(60_000);

      const scamCase = await h.caseOf(body.reference);
      expect(scamCase).toMatchObject({
        reporterUserId: reporter.userId,
        recipientUserId: recipient.userId,
        reportedAmount: 2_000_000n,
        heldAmount: 2_000_000n,
        recoveredAmount: 0n,
        reimbursedAmount: null,
        contactChannel: 'WhatsApp',
        status: 'open',
      });
      expect(await h.balanceOf(recipient)).toBe(1_000_000n);
      expect((await h.fraudHoldBalance()) - before).toBe(2_000_000n);
      await assertInvariantHolds(ctx.accountRepo);

      const hold = await ctx.transactionRepo.findOneByOrFail({
        reference: `${body.reference}-hold`,
      });
      expect(hold).toMatchObject({
        type: 'fraud_hold',
        status: 'completed',
        amount: 2_000_000n,
        senderWalletId: recipient.walletId,
      });
      expect(
        await ctx.ledgerEntryRepo.findBy({ transactionId: hold.id }),
      ).toHaveLength(2);

      const [flag] = await h.openScamFlags(recipient);
      expect(flag).toMatchObject({
        status: 'open',
        enforced: true,
        hitCount: 1,
        kind: 'fraud',
      });
      expect(await h.openRestrictions(recipient)).toHaveLength(0);

      const audit = await auditFor('scam_report_filed', scamCase.id);
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({
        reference: body.reference,
        held: '2000000',
        shortfall: '0',
      });

      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === recipient.email &&
            m.text.includes('on hold') &&
            m.text.includes(body.reference),
        ),
      );
    });

    it('holds only what is left and records the shortfall when the recipient has spent some of it', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(0n);
      const other = await h.seed();
      const transactionId = await h.send(reporter, recipient, 2_000_000);
      await h.send(recipient, other, 1_500_000);

      const res = await h.report(reporter, transactionId).expect(201);
      const { reference } = dataOf<{ reference: string }>(res);

      const scamCase = await h.caseOf(reference);
      expect(scamCase.reportedAmount).toBe(2_000_000n);
      expect(scamCase.heldAmount).toBe(500_000n);
      expect(await h.balanceOf(recipient)).toBe(0n);
      await assertInvariantHolds(ctx.accountRepo);

      const view = dataOf<{ shortfall: { amount: string } }>(
        await h
          .reviewer(h.http().get(`/internal/risk/scam-cases/${reference}`))
          .expect(200),
      );
      expect(view.shortfall.amount).toBe('1500000');
      expect(JSON.stringify(res.body)).not.toContain('500000');
    });

    it('opens the case, raises the flag and posts nothing when the recipient has a zero balance', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(0n);
      const other = await h.seed();
      const transactionId = await h.send(reporter, recipient, 1_000_000);
      await h.send(recipient, other, 1_000_000);
      const before = await h.fraudHoldBalance();

      const { reference } = dataOf<{ reference: string }>(
        await h.report(reporter, transactionId).expect(201),
      );

      const scamCase = await h.caseOf(reference);
      expect(scamCase.heldAmount).toBe(0n);
      expect(scamCase.status).toBe('open');
      expect(await h.fraudHoldBalance()).toBe(before);
      expect(
        await ctx.transactionRepo.findOneBy({ reference: `${reference}-hold` }),
      ).toBeNull();
      expect(await h.openScamFlags(recipient)).toHaveLength(1);
      await assertInvariantHolds(ctx.accountRepo);

      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === recipient.email &&
            m.text.includes('under review') &&
            m.text.includes(reference),
        ),
      );
    });

    it('holds the recipient’s withdrawals while the flag is open and lets the P2P money they hold stay in the books', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(20_000_000n);
      const transactionId = await h.send(reporter, recipient, 1_000_000);
      await h.report(reporter, transactionId).expect(201);

      const { reference } = await withdraw(ctx, recipient, 50_000);

      expect(await statusOf(ctx, reference)).toBe('under_review');
    });
  });

  describe('who can report what', () => {
    it('reports a transfer only once', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const transactionId = await h.send(reporter, recipient, 500_000);
      await h.report(reporter, transactionId).expect(201);
      const heldAfterFirst = await h.fraudHoldBalance();

      const second = await h.report(reporter, transactionId).expect(409);

      expect(errorOf(second).code).toBe('SCAM_REPORT_ALREADY_FILED');
      expect(await h.fraudHoldBalance()).toBe(heldAfterFirst);
      expect(
        await ctx.dataSource.query(
          `SELECT 1 FROM scam_cases WHERE transaction_id = $1`,
          [transactionId],
        ),
      ).toHaveLength(1);
    });

    it('lets only the sender report, answering the recipient and a stranger as if it did not exist', async () => {
      const sender = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const stranger = await h.seed();
      const transactionId = await h.send(sender, recipient, 500_000);

      for (const user of [recipient, stranger]) {
        const res = await h.report(user, transactionId).expect(404);
        expect(errorOf(res).code).toBe('SCAM_REPORT_TRANSFER_NOT_FOUND');
      }
      await h
        .report(sender, '00000000-0000-4000-8000-000000000000')
        .expect(404);
      expect(await h.openScamFlags(recipient)).toHaveLength(0);
    });

    it('refuses a transfer that is not completed', async () => {
      const sender = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const transactionId = await h.send(sender, recipient, 500_000);
      await ctx.transactionRepo.update(
        { id: transactionId },
        { status: 'reversed' },
      );

      const res = await h.report(sender, transactionId).expect(422);

      expect(errorOf(res).code).toBe('SCAM_REPORT_NOT_REPORTABLE');
    });

    it('refuses anything that is not a P2P transfer', async () => {
      const sender = await h.seed(5_000_000n);
      const funding = await ctx.transactionRepo.findOneByOrFail({
        reference: `fund-${sender.userId}`,
      });

      const res = await h.report(sender, funding.id).expect(404);

      expect(errorOf(res).code).toBe('SCAM_REPORT_TRANSFER_NOT_FOUND');
    });

    it('accepts a report up to 30 days after the transfer and refuses it after', async () => {
      const sender = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const recent = await h.send(sender, recipient, 100_000);
      const old = await h.send(sender, recipient, 100_000);
      await h.ageTransfer(recent, 29 * 24);
      await h.ageTransfer(old, 31 * 24);

      await h.report(sender, recent).expect(201);
      const res = await h.report(sender, old).expect(422);

      expect(errorOf(res).code).toBe('SCAM_REPORT_WINDOW_EXPIRED');
    });

    it('marks a report made after 72 hours late and one made inside it on time, and investigates both', async () => {
      const sender = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const inTime = await h.send(sender, recipient, 100_000);
      const late = await h.send(sender, recipient, 100_000);
      await h.ageTransfer(inTime, 71);
      await h.ageTransfer(late, 73);

      const onTimeCase = await h.fileReport(sender, inTime);
      const lateCase = await h.fileReport(sender, late);

      expect(onTimeCase.late).toBe(false);
      expect(lateCase.late).toBe(true);
      expect((await h.caseOf(lateCase.reference)).heldAmount).toBe(100_000n);
    });

    it('reports a money-request payment like any other P2P transfer', async () => {
      const payer = await h.seed(5_000_000n);
      const requester = await h.seed(0n);
      const requests = ctx.app.get(MoneyRequestsService);
      const created = await requests.createRequest(requester.userId, {
        payerUserId: payer.userId,
        amount: 300_000,
      });
      await requests.payRequest(payer.userId, created.id, {
        reference: `pay-${created.id}`,
        pin: '1234',
        visibility: 'private',
      });
      const payment = await ctx.transactionRepo.findOneByOrFail({
        senderWalletId: payer.walletId,
        type: 'p2p_transfer',
      });

      const res = await h.report(payer, payment.id).expect(201);

      expect(dataOf<{ status: string }>(res).status).toBe('open');
      expect(await h.balanceOf(requester)).toBe(0n);
      expect(
        (await h.caseOf(dataOf<{ reference: string }>(res).reference))
          .heldAmount,
      ).toBe(300_000n);
    });

    it('rejects a malformed report', async () => {
      const sender = await h.seed();

      await h.report(sender, 'not-a-uuid').expect(400);
      await h
        .report(sender, '00000000-0000-4000-8000-000000000000', {
          category: 'made_up',
        })
        .expect(400);
      await h
        .report(sender, '00000000-0000-4000-8000-000000000000', {
          description: 'short',
        })
        .expect(400);
    });
  });

  describe('more than one reporter', () => {
    it('restricts the recipient’s outbound money when a second distinct reporter files, sourced to that case', async () => {
      const first = await h.seed(5_000_000n);
      const second = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const firstCase = await h.fileReport(
        first,
        await h.send(first, recipient, 100_000),
      );
      expect(await h.openRestrictions(recipient)).toHaveLength(0);

      const secondCase = await h.fileReport(
        second,
        await h.send(second, recipient, 100_000),
      );

      const [restriction] = await h.openRestrictions(recipient);
      expect(restriction).toMatchObject({
        scope: 'outbound',
        sourceId: (await h.caseOf(secondCase.reference)).id,
      });
      expect((await h.caseOf(secondCase.reference)).restrictionAdded).toBe(
        true,
      );
      expect((await h.caseOf(firstCase.reference)).restrictionAdded).toBe(
        false,
      );
      const [flag] = await h.openScamFlags(recipient);
      expect(flag.hitCount).toBe(2);
    });

    it('does not restrict for two reports from the same person', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      await h.fileReport(reporter, await h.send(reporter, recipient, 100_000));
      await h.fileReport(reporter, await h.send(reporter, recipient, 100_000));

      expect(await h.openRestrictions(recipient)).toHaveLength(0);
      const [flag] = await h.openScamFlags(recipient);
      expect(flag.hitCount).toBe(2);
    });
  });

  describe('the recipient’s side', () => {
    it('stores the response on the open case, audits it, and lets the recipient only', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const stranger = await h.seed();
      const { reference } = await h.fileReport(
        reporter,
        await h.send(reporter, recipient, 100_000),
      );

      await h
        .http()
        .post(`/scam-reports/${reference}/response`)
        .set(h.bearer(recipient))
        .send({ response: 'It was payment for the phone I sold.' })
        .expect(204);
      await h
        .http()
        .post(`/scam-reports/${reference}/response`)
        .set(h.bearer(stranger))
        .send({ response: 'Not mine.' })
        .expect(404);
      await h
        .http()
        .post(`/scam-reports/${reference}/response`)
        .set(h.bearer(reporter))
        .send({ response: 'I am the reporter.' })
        .expect(404);
      await h
        .http()
        .post(`/scam-reports/${reference}/response`)
        .set(h.bearer(recipient))
        .send({ response: '' })
        .expect(400);

      const scamCase = await h.caseOf(reference);
      expect(scamCase.recipientResponse).toBe(
        'It was payment for the phone I sold.',
      );
      expect(scamCase.recipientRespondedAt).not.toBeNull();
      expect(await auditFor('scam_report_responded', scamCase.id)).toHaveLength(
        1,
      );
    });

    it('refuses a response once the case is decided', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(1_000_000n);
      const { reference } = await h.fileReport(
        reporter,
        await h.send(reporter, recipient, 100_000),
      );
      await h.resolve(reference, 'rejected').expect(200);

      const res = await h
        .http()
        .post(`/scam-reports/${reference}/response`)
        .set(h.bearer(recipient))
        .send({ response: 'Too late.' })
        .expect(409);

      expect(errorOf(res).code).toBe('SCAM_CASE_ALREADY_DECIDED');
    });
  });

  describe('rate limiting', () => {
    it('limits each reporter to five reports an hour without affecting anyone else', async () => {
      const reporter = await h.seed(5_000_000n);
      const other = await h.seed(5_000_000n);
      const missing = '00000000-0000-4000-8000-000000000000';

      for (let i = 0; i < 5; i++) {
        await h.report(reporter, missing).expect(404);
      }
      const limited = await h.report(reporter, missing);

      expect(limited.status).toBe(429);
      await h.report(other, missing).expect(404);
    });
  });

  describe('listing own reports', () => {
    it('shows the reporter their cases without the recipient’s balance', async () => {
      const reporter = await h.seed(5_000_000n);
      const recipient = await h.seed(100_000n);
      const { reference } = await h.fileReport(
        reporter,
        await h.send(reporter, recipient, 300_000),
      );

      const list = dataOf<Record<string, unknown>[]>(
        await h.http().get('/scam-reports').set(h.bearer(reporter)).expect(200),
      );

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ reference, status: 'open' });
      expect(list[0]).not.toHaveProperty('heldAmount');
      const none = dataOf<unknown[]>(
        await h
          .http()
          .get('/scam-reports')
          .set(h.bearer(recipient))
          .expect(200),
      );
      expect(none).toHaveLength(0);
    });
  });
});
