import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  atClock,
  createSchedulingHelpers,
  createSchedulingTestContext,
  lagosAt,
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { ScheduledPaymentRun } from '../../src/modules/scheduling/entities/scheduled-payment-run.entity';
import { LedgerEntry } from '../../src/modules/ledger/entities/ledger-entry.entity';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import {
  addDays,
  computeDueAt,
  lagosToday,
  runDate,
  startDateBounds,
} from '../../src/modules/scheduling/internal/run-time';

jest.setTimeout(180_000);

describe('PATCH /scheduled-payments/:id', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const today = () => lagosToday(new Date());
  const inDays = (n: number) => addDays(today(), n);
  const daily = { interval: { unit: 'day', count: 1 } };

  async function seedSchedule(
    options: { body?: Record<string, unknown>; balanceMinor?: bigint } = {},
  ) {
    const sender = await h.seedUser('sender', {
      balanceMinor: options.balanceMinor ?? 5_000_000n,
    });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, {
          startDate: inDays(3),
          ...options.body,
        })
        .expect(201),
    );
    return { sender, recipient, schedule };
  }

  const patch = (
    user: ScheduleUser,
    id: string,
    body: Record<string, unknown>,
  ) =>
    h
      .http()
      .patch(`/scheduled-payments/${id}`)
      .set('Authorization', `Bearer ${h.tokenFor(user.userId)}`)
      .send(body);

  const view = async (user: ScheduleUser, id: string) =>
    dataOf<ScheduleBody>(await h.getSchedule(user.userId, id).expect(200));

  const row = (id: string) => h.scheduleRepo().findOneByOrFail({ id });

  const changesOf = (id: string) =>
    ctx.dataSource.getRepository(ScheduledPaymentChange).find({
      where: { scheduledPaymentId: id },
      order: { createdAt: 'ASC' },
    });

  const updatedChanges = async (id: string) =>
    (await changesOf(id)).filter((c) => c.kind === 'updated');

  const notificationsOf = (user: ScheduleUser) =>
    ctx.notificationRepo.findBy({
      userId: user.userId,
      type: 'scheduled_payment_updated',
    });

  const failedPinAttempts = async (user: ScheduleUser) =>
    Number(
      (
        await ctx.dataSource.query<{ failed_pin_attempts: number }[]>(
          `SELECT failed_pin_attempts FROM credentials WHERE user_id = $1`,
          [user.userId],
        )
      )[0].failed_pin_attempts,
    );

  const queue = () =>
    ctx.app.get<Queue>(getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE));

  const debitedBy = async (transactionId: string) =>
    (
      await ctx.dataSource
        .getRepository(LedgerEntry)
        .findBy({ transactionId, direction: 'debit' })
    ).map((entry) => entry.amount);

  // Queue muted, so nothing executes the run until the test says so.
  async function claimRun(scheduleId: string): Promise<ScheduledPaymentRun> {
    await h.makeDue(scheduleId);
    const addBulk = jest
      .spyOn(queue(), 'addBulk')
      .mockResolvedValue([] as never);
    try {
      await h.engine().sweep();
    } finally {
      addBulk.mockRestore();
    }
    const runs = await h.runsOf(scheduleId);
    return runs[runs.length - 1];
  }

  const execute = (runId: string) => h.engine().executeRun(runId);

  describe('who and what', () => {
    it('is owner only', async () => {
      const { schedule } = await seedSchedule();
      const stranger = await h.seedUser('stranger');

      await patch(stranger, schedule.id, { note: 'x' }).expect(404);
      await patch(stranger, randomUUID(), { note: 'x' }).expect(404);
    });

    it.each([
      ['target', { target: { type: 'user', userId: randomUUID() } }],
      ['recipientUserId', { recipientUserId: randomUUID() }],
    ])('rejects the payee field %s with 400', async (_name, body) => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, { ...body, pin: '1234' }).expect(400);

      expect((await row(schedule.id)).recipientUserId).toBe(
        schedule.target.userId,
      );
    });

    it('does nothing for an empty body', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, {}).expect(200);

      expect(await updatedChanges(schedule.id)).toHaveLength(0);
    });

    it.each([
      ['a non-positive amount', { amount: -5, pin: '1234' }],
      ['a bad visibility', { visibility: 'friends' }],
      ['a malformed pin', { amount: 200_000, pin: '12' }],
      ['an unknown field', { colour: 'red' }],
    ])('rejects %s with 400', async (_name, body) => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, body).expect(400);

      expect(await updatedChanges(schedule.id)).toHaveLength(0);
    });
  });

  describe('PIN', () => {
    it.each([
      ['amount', { amount: 200_000 }],
      ['interval', { interval: { unit: 'week', count: 1 } }],
      ['nextRunDate', { nextRunDate: inDays(5) }],
      ['endDate', { endDate: inDays(30) }],
      ['maxRuns', { maxRuns: 4 }],
    ])('requires the pin for %s', async (_field, body) => {
      const { sender, schedule } = await seedSchedule({ body: daily });

      const res = await patch(sender, schedule.id, body).expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_PIN_REQUIRED');
      expect(await updatedChanges(schedule.id)).toHaveLength(0);
    });

    it('rejects a wrong pin with 401 and changes nothing', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, { amount: 200_000, pin: '9999' }).expect(
        401,
      );

      expect((await view(sender, schedule.id)).amount.amount).toBe('100000');
    });

    it('needs no pin for the note and visibility alone, and sends no notification for them', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { note: 'Rent', visibility: 'private' },
      });

      const res = await patch(sender, schedule.id, {
        note: 'Rent, March',
        visibility: 'public',
      }).expect(200);

      expect(dataOf<ScheduleBody>(res)).toMatchObject({
        note: 'Rent, March',
        visibility: 'public',
      });
      const [change] = await updatedChanges(schedule.id);
      expect(change.changes).toEqual({
        note: { from: 'Rent', to: 'Rent, March' },
        visibility: { from: 'private', to: 'public' },
      });
      await h.waitForQueuesDrained();
      expect(await notificationsOf(sender)).toHaveLength(0);
    });

    it('clears the note with null or an empty string', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { note: 'Rent' },
      });

      await patch(sender, schedule.id, { note: null }).expect(200);
      expect((await view(sender, schedule.id)).note).toBeNull();

      await patch(sender, schedule.id, { note: 'Back' }).expect(200);
      await patch(sender, schedule.id, { note: '  ' }).expect(200);
      expect((await view(sender, schedule.id)).note).toBeNull();
    });

    it('validates before the pin, so an invalid edit costs no pin attempt', async () => {
      const { sender, schedule } = await seedSchedule();
      const before = await failedPinAttempts(sender);

      const res = await patch(sender, schedule.id, {
        nextRunDate: today(),
        pin: '9999',
      }).expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_NEXT_RUN_DATE_INVALID');
      expect(await failedPinAttempts(sender)).toBe(before);
    });
  });

  describe('validation', () => {
    it('applies the creation amount rules to a changed amount', async () => {
      const sender = await h.seedUser('sender', { kycTier: 'tier1' });
      const recipient = await h.seedUser('recipient');
      const schedule = dataOf<ScheduleBody>(
        await h.createSchedule(sender.userId, recipient.userId).expect(201),
      );

      const small = await patch(sender, schedule.id, {
        amount: 1,
        pin: '1234',
      }).expect(422);
      expect(errorOf(small).code).toBe('TRANSFER_AMOUNT_TOO_SMALL');
      const over = await patch(sender, schedule.id, {
        amount: 5_000_001,
        pin: '1234',
      }).expect(422);
      expect(errorOf(over).code).toBe('SCHEDULE_AMOUNT_EXCEEDS_DAILY_LIMIT');

      await patch(sender, schedule.id, {
        amount: 5_000_000,
        pin: '1234',
      }).expect(200);
      expect((await view(sender, schedule.id)).amount.amount).toBe('5000000');
    });

    it.each([
      ['a day count over 365', { interval: { unit: 'day', count: 366 } }],
      ['a week count over 52', { interval: { unit: 'week', count: 53 } }],
      ['a month count over 12', { interval: { unit: 'month', count: 13 } }],
      ['a zero count', { interval: { unit: 'day', count: 0 } }],
      ['an unknown unit', { interval: { unit: 'year', count: 1 } }],
    ])('rejects %s with 400', async (_name, body) => {
      const { sender, schedule } = await seedSchedule({ body: daily });

      await patch(sender, schedule.id, { ...body, pin: '1234' }).expect(400);
    });

    it.each([
      ['today', () => today()],
      ['in the past', () => inDays(-1)],
      ['more than a year ahead', () => inDays(367)],
      ['not a real date', () => '2026-02-30'],
      ['not a date', () => 'next friday'],
    ])('rejects a nextRunDate %s with 400', async (_name, date) => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, {
        nextRunDate: date(),
        pin: '1234',
      }).expect(400);
    });

    it('accepts tomorrow and a year ahead as the next run date', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, {
        nextRunDate: inDays(1),
        pin: '1234',
      }).expect(200);
      await patch(sender, schedule.id, {
        nextRunDate: startDateBounds(new Date()).max,
        pin: '1234',
      }).expect(200);
    });

    it('allows at most one end condition, counting the one already set', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 5 },
      });

      await patch(sender, schedule.id, {
        endDate: inDays(30),
        pin: '1234',
      }).expect(400);
      await patch(sender, schedule.id, {
        endDate: inDays(30),
        maxRuns: 4,
        pin: '1234',
      }).expect(400);

      await patch(sender, schedule.id, {
        endDate: inDays(30),
        maxRuns: null,
        pin: '1234',
      }).expect(200);
      expect(await view(sender, schedule.id)).toMatchObject({
        endDate: inDays(30),
        maxRuns: null,
      });
    });

    it('needs an interval for an end condition, and for it to be cleared with the interval', async () => {
      const oneTime = await seedSchedule();
      await patch(oneTime.sender, oneTime.schedule.id, {
        maxRuns: 3,
        pin: '1234',
      }).expect(400);
      await patch(oneTime.sender, oneTime.schedule.id, {
        endDate: inDays(9),
        pin: '1234',
      }).expect(400);

      const recurring = await seedSchedule({ body: { ...daily, maxRuns: 5 } });
      await patch(recurring.sender, recurring.schedule.id, {
        interval: null,
        pin: '1234',
      }).expect(400);
      await patch(recurring.sender, recurring.schedule.id, {
        interval: null,
        maxRuns: null,
        pin: '1234',
      }).expect(200);
      expect(await view(recurring.sender, recurring.schedule.id)).toMatchObject(
        { interval: null, maxRuns: null },
      );
    });

    it('rejects an end date before the next run date, and never completes the schedule', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, startDate: inDays(5) },
      });

      const res = await patch(sender, schedule.id, {
        endDate: inDays(4),
        pin: '1234',
      }).expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_RECURRENCE_INVALID');
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'active',
        endDate: null,
        nextRunDate: inDays(5),
      });
      await patch(sender, schedule.id, {
        endDate: inDays(5),
        pin: '1234',
      }).expect(200);
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'active',
        endDate: inDays(5),
      });
    });

    it('rejects moving the next run date past the existing end date', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, endDate: inDays(10) },
      });

      await patch(sender, schedule.id, {
        nextRunDate: inDays(11),
        pin: '1234',
      }).expect(400);
    });

    it('rejects a maxRuns below the runs created, counting every created run', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 5 },
      });
      await execute((await claimRun(schedule.id)).id);
      await claimRun(schedule.id);
      await h.waitForQueuesDrained();

      const res = await patch(sender, schedule.id, {
        maxRuns: 1,
        pin: '1234',
      }).expect(400);

      expect(errorOf(res).message).toMatch(/at least 2/);
      expect((await view(sender, schedule.id)).maxRuns).toBe(5);
    });
  });

  describe('re-anchoring', () => {
    it('moves the next run to nextRunDate and anchors the rhythm there', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { interval: { unit: 'week', count: 1 }, startDate: inDays(3) },
      });
      const before = await row(schedule.id);

      const res = await patch(sender, schedule.id, {
        nextRunDate: inDays(10),
        pin: '1234',
      }).expect(200);

      const after = await row(schedule.id);
      expect(after.startDate).toBe(inDays(10));
      expect(after.anchorRunNumber).toBe(after.nextRunNumber);
      expect(after.nextRunAt).toEqual(
        computeDueAt(inDays(10), '06:00', before.runOffsetMinutes),
      );
      expect(dataOf<ScheduleBody>(res).nextRunDate).toBe(inDays(10));
      const [change] = await updatedChanges(schedule.id);
      expect(change.changes).toEqual({
        nextRunDate: { from: inDays(3), to: inDays(10) },
      });
    });

    it('moves a 31st-anchored monthly schedule to the 15th and keeps the 15th afterwards', async () => {
      let start = inDays(2);
      while (start.slice(8) !== '31') {
        start = addDays(start, 1);
      }
      const { sender, schedule } = await seedSchedule({
        body: { interval: { unit: 'month', count: 1 }, startDate: start },
      });
      const fifteenth = addDays(start, -16);

      await patch(sender, schedule.id, {
        nextRunDate: fifteenth,
        pin: '1234',
      }).expect(200);

      const moved = await row(schedule.id);
      expect(moved.startDate).toBe(fifteenth);
      expect(moved.anchorRunNumber).toBe(1);
      expect(lagosToday(moved.nextRunAt!)).toBe(fifteenth);

      await claimRun(schedule.id);
      const afterRun = await row(schedule.id);
      expect(afterRun.nextRunNumber).toBe(2);
      expect(afterRun.anchorRunNumber).toBe(1);
      const following = lagosToday(afterRun.nextRunAt!);
      expect(following.slice(8)).toBe('15');
      expect(following).toBe(
        runDate(fifteenth, 1, { unit: 'month', count: 1 }, 2),
      );
    });

    it('re-anchors at the current anchor offset after runs have been created', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      await claimRun(schedule.id);
      await h.waitForQueuesDrained();
      const mid = await row(schedule.id);
      expect(mid.nextRunNumber).toBe(2);

      await patch(sender, schedule.id, {
        nextRunDate: inDays(20),
        pin: '1234',
      }).expect(200);

      const after = await row(schedule.id);
      expect(after.anchorRunNumber).toBe(2);
      expect(after.startDate).toBe(inDays(20));
      expect(after.nextRunNumber).toBe(2);
    });

    it('re-anchors an interval change at the run that was due next', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { interval: { unit: 'week', count: 1 }, startDate: inDays(4) },
      });
      const before = await row(schedule.id);

      await patch(sender, schedule.id, {
        interval: { unit: 'day', count: 3 },
        pin: '1234',
      }).expect(200);

      const after = await row(schedule.id);
      expect(after).toMatchObject({
        startDate: inDays(4),
        anchorRunNumber: before.nextRunNumber,
        intervalUnit: 'day',
        intervalCount: 3,
      });
      expect(after.nextRunAt).toEqual(before.nextRunAt);
      const [change] = await updatedChanges(schedule.id);
      expect(change.changes).toEqual({
        interval: {
          from: { unit: 'week', count: 1 },
          to: { unit: 'day', count: 3 },
        },
      });

      await claimRun(schedule.id);
      expect(lagosToday((await row(schedule.id)).nextRunAt!)).toBe(inDays(7));
    });

    it('turns a one-time payment into a recurring one, and back', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender, schedule.id, {
        interval: { unit: 'day', count: 2 },
        pin: '1234',
      }).expect(200);
      await claimRun(schedule.id);
      expect(lagosToday((await row(schedule.id)).nextRunAt!)).toBe(inDays(5));

      await patch(sender, schedule.id, { interval: null, pin: '1234' }).expect(
        200,
      );
      const oneTime = await row(schedule.id);
      expect(oneTime).toMatchObject({
        intervalUnit: null,
        intervalCount: null,
        startDate: inDays(5),
        anchorRunNumber: 2,
      });
      expect(lagosToday(oneTime.nextRunAt!)).toBe(inDays(5));
    });

    it('does not re-anchor when nextRunDate equals the current next run date', async () => {
      let start = inDays(2);
      while (start.slice(8) !== '31') {
        start = addDays(start, 1);
      }
      const { sender, schedule } = await seedSchedule({
        body: { interval: { unit: 'month', count: 1 }, startDate: start },
      });

      await patch(sender, schedule.id, {
        nextRunDate: start,
        pin: '1234',
      }).expect(200);

      expect(await row(schedule.id)).toMatchObject({
        startDate: start,
        anchorRunNumber: 1,
      });
      expect(await updatedChanges(schedule.id)).toHaveLength(0);
    });

    it('refuses to move or re-time a schedule with no upcoming run', async () => {
      const { sender, schedule } = await seedSchedule();
      await claimRun(schedule.id);

      const move = await patch(sender, schedule.id, {
        nextRunDate: inDays(9),
        pin: '1234',
      }).expect(422);
      expect(errorOf(move).code).toBe('SCHEDULE_NO_UPCOMING_RUN');
      await patch(sender, schedule.id, {
        interval: { unit: 'day', count: 1 },
        pin: '1234',
      }).expect(422);
    });
  });

  describe('a paused schedule', () => {
    async function paused() {
      const seeded = await seedSchedule({ body: daily });
      await h
        .pauseSchedule(seeded.sender.userId, seeded.schedule.id)
        .expect(201);
      return seeded;
    }

    it('needs a nextRunDate to change its interval', async () => {
      const { sender, schedule } = await paused();

      const res = await patch(sender, schedule.id, {
        interval: { unit: 'week', count: 1 },
        pin: '1234',
      }).expect(422);

      expect(errorOf(res).code).toBe('SCHEDULE_NEXT_RUN_DATE_REQUIRED');
      expect(await updatedChanges(schedule.id)).toHaveLength(0);
    });

    it('takes an edit with a nextRunDate, stays paused with no next run, and resumes on the new rhythm', async () => {
      const { sender, schedule } = await paused();

      await patch(sender, schedule.id, {
        interval: { unit: 'week', count: 2 },
        nextRunDate: inDays(9),
        amount: 150_000,
        pin: '1234',
      }).expect(200);

      const edited = await row(schedule.id);
      expect(edited).toMatchObject({
        status: 'paused',
        nextRunAt: null,
        startDate: inDays(9),
        intervalUnit: 'week',
        intervalCount: 2,
      });
      expect(edited.anchorRunNumber).toBe(edited.nextRunNumber);
      const [change] = await updatedChanges(schedule.id);
      expect(change.changes).toMatchObject({
        nextRunDate: { from: null, to: inDays(9) },
        amount: { from: '100000', to: '150000' },
      });

      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(201);

      expect(dataOf<ScheduleBody>(res)).toMatchObject({
        status: 'active',
        nextRunDate: inDays(9),
        amount: { amount: '150000' },
      });
    });

    it('takes an amount-only edit without a date', async () => {
      const { sender, schedule } = await paused();

      await patch(sender, schedule.id, { amount: 120_000, pin: '1234' }).expect(
        200,
      );

      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        nextRunAt: null,
        amount: { amount: '120000' },
      });
      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(201);
      expect(dataOf<ScheduleBody>(res).status).toBe('active');
    });

    it('rejects an end condition that would leave nothing to resume', async () => {
      const { sender, schedule } = await paused();
      await h.runRepo().save(
        h.runRepo().create({
          scheduledPaymentId: schedule.id,
          runNumber: 99,
          dueAt: new Date(),
          status: 'cancelled',
          amount: 1n,
          targetType: 'user',
          recipientUserId: schedule.target.userId,
          note: null,
          visibility: 'private',
        }),
      );

      const res = await patch(sender, schedule.id, {
        maxRuns: 1,
        pin: '1234',
      }).expect(422);

      expect(errorOf(res).code).toBe('SCHEDULE_EDIT_LEAVES_NO_RUN');
    });
  });

  describe('status', () => {
    it('rejects editing a cancelled schedule with 409', async () => {
      const { sender, schedule } = await seedSchedule();
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);

      const res = await patch(sender, schedule.id, { note: 'x' }).expect(409);

      expect(errorOf(res).code).toBe('SCHEDULE_STATUS_CONFLICT');
    });

    it('rejects editing a completed schedule with 409', async () => {
      const { sender, schedule } = await seedSchedule();
      await execute((await claimRun(schedule.id)).id);
      expect((await view(sender, schedule.id)).status).toBe('completed');

      await patch(sender, schedule.id, { note: 'x' }).expect(409);
      await patch(sender, schedule.id, { amount: 200_000, pin: '1234' }).expect(
        409,
      );
    });
  });

  describe('maxRuns lowered to the runs created', () => {
    it('completes the schedule when no run is pending', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 5 },
      });
      await execute((await claimRun(schedule.id)).id);
      await h.waitForQueuesDrained();

      const res = await patch(sender, schedule.id, {
        maxRuns: 1,
        pin: '1234',
      }).expect(200);

      expect(dataOf<ScheduleBody>(res)).toMatchObject({
        status: 'completed',
        nextRunAt: null,
        maxRuns: 1,
        runsUsed: 1,
      });
      expect((await changesOf(schedule.id)).map((c) => c.kind).sort()).toEqual([
        'completed',
        'created',
        'updated',
      ]);
    });

    it('leaves the schedule active while a run is pending, and completes it when that run ends', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 5 },
      });
      const run = await claimRun(schedule.id);

      const res = await patch(sender, schedule.id, {
        maxRuns: 1,
        pin: '1234',
      }).expect(200);

      expect(dataOf<ScheduleBody>(res)).toMatchObject({
        status: 'active',
        nextRunAt: null,
      });
      await execute(run.id);
      expect((await view(sender, schedule.id)).status).toBe('completed');
    });
  });

  describe('snapshots', () => {
    it('lets a run mid-retry pay its old amount, and the next run the new one', async () => {
      const { sender, schedule } = await seedSchedule({
        body: daily,
        balanceMinor: 50_000n,
      });
      const run = await claimRun(schedule.id);
      const firstTry = lagosAt(lagosToday(run.dueAt), '08:00');
      await atClock(firstTry, () => execute(run.id));
      expect(await h.runRepo().findOneByOrFail({ id: run.id })).toMatchObject({
        status: 'pending',
        attemptCount: 1,
      });

      await patch(sender, schedule.id, { amount: 40_000, pin: '1234' }).expect(
        200,
      );
      expect((await row(schedule.id)).amount).toBe(40_000n);
      expect((await h.runRepo().findOneByOrFail({ id: run.id })).amount).toBe(
        100_000n,
      );

      await fundWallet(ctx, {
        reference: `topup-${randomUUID()}`,
        walletId: sender.walletId,
        netAmountMinor: 5_000_000n,
      });
      await atClock(new Date(firstTry.getTime() + 2 * 3_600_000), () =>
        execute(run.id),
      );

      const retried = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(retried.status).toBe('succeeded');
      expect(await debitedBy(retried.transactionId!)).toEqual([100_000n]);

      const next = await claimRun(schedule.id);
      expect(next.amount).toBe(40_000n);
      await execute(next.id);
      const nextRun = await h.runRepo().findOneByOrFail({ id: next.id });
      expect(await debitedBy(nextRun.transactionId!)).toEqual([40_000n]);
    });
  });

  describe('changes and notification', () => {
    it('records only the fields that changed, and notifies by email and in-app for a pin-gated change', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { note: 'Rent' },
      });

      await patch(sender, schedule.id, {
        amount: 175_000,
        note: 'Rent',
        visibility: 'private',
        pin: '1234',
      }).expect(200);

      const changes = await updatedChanges(schedule.id);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        actor: 'user',
        changes: { amount: { from: '100000', to: '175000' } },
      });
      expect(Object.keys(changes[0].changes!)).toEqual(['amount']);

      await waitFor(async () => (await notificationsOf(sender)).length === 1);
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) => m.to === sender.email && /was changed/i.test(m.subject),
        ),
      );
      const [inApp] = await notificationsOf(sender);
      expect(inApp.dedupeKey).toBe(changes[0].id);
      const email = ctx.emailAdapter.sent.find(
        (m) => m.to === sender.email && /was changed/i.test(m.subject),
      )!;
      expect(JSON.stringify(email)).toContain(
        'cancel it in the app and secure your account',
      );
    });

    it('writes no row and sends nothing for an edit that changes nothing', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, note: 'Rent' },
      });
      const before = await row(schedule.id);

      await patch(sender, schedule.id, {
        amount: 100_000,
        interval: { unit: 'day', count: 1 },
        nextRunDate: inDays(3),
        note: 'Rent',
        visibility: 'private',
        pin: '1234',
      }).expect(200);

      expect(await updatedChanges(schedule.id)).toHaveLength(0);
      expect((await row(schedule.id)).updatedAt).toEqual(before.updatedAt);
      await h.waitForQueuesDrained();
      expect(await notificationsOf(sender)).toHaveLength(0);
    });

    it('does not notify the recipient', async () => {
      const { sender, recipient, schedule } = await seedSchedule();

      await patch(sender, schedule.id, { amount: 130_000, pin: '1234' }).expect(
        200,
      );
      await h.waitForQueuesDrained();

      expect(
        await ctx.notificationRepo.countBy({
          userId: recipient.userId,
          type: 'scheduled_payment_updated',
        }),
      ).toBe(0);
    });
  });

  describe('concurrency with the sweep', () => {
    it('is skipped by the sweep while an edit holds the schedule lock, and the edit lands first', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      await h.makeDue(schedule.id);

      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query(
        `SELECT id FROM scheduled_payments WHERE id = $1 FOR UPDATE`,
        [schedule.id],
      );
      try {
        await h.engine().sweep();
        expect(await h.runsOf(schedule.id)).toHaveLength(0);

        let settled = false;
        const edit = patch(sender, schedule.id, {
          amount: 60_000,
          pin: '1234',
        }).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        await runner.commitTransaction();
        expect((await edit).status).toBe(200);
      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }
        await runner.release();
      }

      await h.makeDue(schedule.id);
      await h.engine().sweep();
      const runs = await h.runsOf(schedule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].amount).toBe(60_000n);
    });

    it('serialises an edit against a racing sweep: the run takes the old or the new snapshot whole, and the re-anchor matches', async () => {
      const newDate = inDays(12);
      const trials = await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const seeded = await seedSchedule({ body: daily });
          await h.makeDue(seeded.schedule.id);
          return seeded;
        }),
      );

      await Promise.all(
        trials.flatMap(({ sender, schedule }) => [
          h.engine().sweep(),
          patch(sender, schedule.id, {
            amount: 70_000,
            nextRunDate: newDate,
            pin: '1234',
          }).then((res) => expect(res.status).toBe(200)),
        ]),
      );

      for (const { schedule } of trials) {
        const after = await row(schedule.id);
        const runs = await h.runsOf(schedule.id);
        expect(after.amount).toBe(70_000n);
        expect(after.startDate).toBe(newDate);
        if (runs.length === 0) {
          expect(after.nextRunNumber).toBe(1);
          expect(after.anchorRunNumber).toBe(1);
        } else {
          expect(runs).toHaveLength(1);
          expect(runs[0].amount).toBe(100_000n);
          expect(after.nextRunNumber).toBe(2);
          expect(after.anchorRunNumber).toBe(2);
        }
        expect(lagosToday(after.nextRunAt!)).toBe(newDate);
      }
    });
  });
});
