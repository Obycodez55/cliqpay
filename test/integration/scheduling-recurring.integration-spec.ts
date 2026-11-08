import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
  tomorrow,
} from './support/scheduling-test-context';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import { dataOf, errorOf } from './support/api-response';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { addDays } from '../../src/modules/scheduling/internal/run-time';

jest.setTimeout(180_000);

function lagosMinuteOfDay(iso: string): number {
  const date = new Date(iso);
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + 60) % 1440;
}

// First Lagos date from tomorrow on that is the 31st, which always exists
// within the allowed one-year window.
function nextThirtyFirst(): string {
  let date = tomorrow();
  while (!date.endsWith('-31')) {
    date = addDays(date, 1);
  }
  return date;
}

// The expected date of the nth month after `anchor`, worked out with plain
// Date arithmetic rather than the code under test.
function monthsAfter(anchor: string, months: number): string {
  const [year, month, day] = anchor.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0));
  const clamped = Math.min(day, lastDay.getUTCDate());
  return new Date(Date.UTC(year, month - 1 + months, clamped))
    .toISOString()
    .slice(0, 10);
}

describe('Recurring scheduled payments', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSchedule(
    body: Record<string, unknown> = {},
    balanceMinor = 5_000_000n,
  ) {
    const sender = await h.seedUser('sender', { balanceMinor });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId, body).expect(201),
    );
    return { sender, recipient, schedule };
  }

  // Waits for the run to end so its worker isn't holding the schedule row,
  // which the sweep would then skip until its next tick.
  async function sweepOnce(scheduleId: string) {
    await h.makeDue(scheduleId);
    await h.engine().sweep();
    await h.waitForRunEnd(scheduleId);
    return h.scheduleRepo().findOneByOrFail({ id: scheduleId });
  }

  const changeKindsOf = async (scheduleId: string) =>
    (
      await ctx.dataSource.getRepository(ScheduledPaymentChange).find({
        where: { scheduledPaymentId: scheduleId },
        order: { createdAt: 'ASC' },
      })
    ).map((c) => c.kind);

  describe('create', () => {
    it('stores the interval and end condition and returns them', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'week', count: 2 },
        maxRuns: 6,
      });

      expect(schedule).toMatchObject({
        interval: { unit: 'week', count: 2 },
        endDate: null,
        maxRuns: 6,
        runsUsed: 0,
        status: 'active',
        nextRunDate: tomorrow(),
      });
    });

    it('is a one-time schedule without an interval', async () => {
      const { schedule } = await seedSchedule();

      expect(schedule).toMatchObject({
        interval: null,
        endDate: null,
        maxRuns: null,
      });
    });

    it.each([
      ['a day count over 365', { unit: 'day', count: 366 }],
      ['a week count over 52', { unit: 'week', count: 53 }],
      ['a month count over 12', { unit: 'month', count: 13 }],
      ['a zero count', { unit: 'day', count: 0 }],
      ['an unknown unit', { unit: 'year', count: 1 }],
    ])('rejects %s', async (_label, interval) => {
      const sender = await h.seedUser('sender', { balanceMinor: 1_000_000n });
      const recipient = await h.seedUser('recipient');

      await h
        .createSchedule(sender.userId, recipient.userId, { interval })
        .expect(400);
    });

    it('accepts the largest count of each unit', async () => {
      for (const interval of [
        { unit: 'day', count: 365 },
        { unit: 'week', count: 52 },
        { unit: 'month', count: 12 },
      ]) {
        await seedSchedule({ interval });
      }
    });

    it('rejects an end condition that does not fit', async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 1_000_000n });
      const recipient = await h.seedUser('recipient');
      const interval = { unit: 'day', count: 1 };
      const start = addDays(tomorrow(), 5);
      const bodies = [
        { startDate: start, interval, endDate: addDays(start, -1) },
        { startDate: start, interval, endDate: '2030-02-30' },
        { interval, endDate: addDays(start, 3), maxRuns: 3 },
        { interval, maxRuns: 367 },
        { interval, maxRuns: 0 },
        { endDate: addDays(tomorrow(), 3) },
        { maxRuns: 3 },
      ];

      for (const body of bodies) {
        await h
          .createSchedule(sender.userId, recipient.userId, body)
          .expect(400);
      }
    });

    it('allows an end date equal to the start date', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
        endDate: tomorrow(),
      });

      expect(schedule.endDate).toBe(tomorrow());
    });

    it('replays an identical create and rejects a changed interval or end condition', async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 1_000_000n });
      const recipient = await h.seedUser('recipient');
      const body = {
        reference: 'sched-recurring-replay',
        interval: { unit: 'month', count: 1 },
        maxRuns: 4,
      };

      const first = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, body)
          .expect(201),
      );
      const replay = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, body)
          .expect(201),
      );
      expect(replay.id).toBe(first.id);

      for (const changed of [
        { interval: { unit: 'month', count: 2 } },
        { interval: { unit: 'week', count: 1 } },
        { maxRuns: 5 },
        { maxRuns: undefined, endDate: addDays(tomorrow(), 90) },
        { interval: undefined, maxRuns: undefined },
      ]) {
        const res = await h
          .createSchedule(sender.userId, recipient.userId, {
            ...body,
            ...changed,
          })
          .expect(409);
        expect(errorOf(res).code).toBe('SCHEDULE_REFERENCE_REUSED');
      }
    });
  });

  describe('sweep', () => {
    it('advances a weekly schedule a week at a time, at a stable time of day', async () => {
      const { sender, schedule } = await seedSchedule({
        interval: { unit: 'week', count: 1 },
      });
      const timeOfDay = lagosMinuteOfDay(schedule.nextRunAt!);
      const start = schedule.nextRunDate!;

      for (let n = 1; n <= 4; n++) {
        const swept = await sweepOnce(schedule.id);
        expect(swept.status).toBe('active');
        expect(swept.nextRunNumber).toBe(n + 1);

        const view = dataOf<ScheduleBody>(
          await h.getSchedule(sender.userId, schedule.id).expect(200),
        );
        expect(view.nextRunDate).toBe(addDays(start, 7 * n));
        expect(view.runsUsed).toBe(n);
        expect(lagosMinuteOfDay(view.nextRunAt!)).toBe(timeOfDay);
      }

      const runs = await h.runsOf(schedule.id);
      expect(runs.map((r) => r.runNumber)).toEqual([1, 2, 3, 4]);
    });

    it('does not complete a recurring schedule when a run finishes', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
      });

      await sweepOnce(schedule.id);
      await h.waitForRunEnd(schedule.id);

      const after = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect((await h.runsOf(schedule.id))[0].status).toBe('succeeded');
      expect(after.status).toBe('active');
      expect(after.nextRunAt).not.toBeNull();
      expect(await changeKindsOf(schedule.id)).toEqual(['created']);
    });

    it('steps a biweekly schedule fourteen days', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'week', count: 2 },
      });
      const start = schedule.nextRunDate!;

      await sweepOnce(schedule.id);
      await sweepOnce(schedule.id);
      const third = await sweepOnce(schedule.id);

      expect(third.nextRunNumber).toBe(4);
      const runs = await h.runsOf(schedule.id);
      expect(runs).toHaveLength(3);
      const lagosDate = (d: Date) =>
        new Date(d.getTime() + 60 * 60_000).toISOString().slice(0, 10);
      expect(lagosDate(third.nextRunAt!)).toBe(addDays(start, 42));
    });

    it('computes a monthly schedule from the 31st against the anchor, not the previous run', async () => {
      const anchor = nextThirtyFirst();
      const { sender, schedule } = await seedSchedule({
        startDate: anchor,
        interval: { unit: 'month', count: 1 },
      });
      expect(schedule.nextRunDate).toBe(anchor);

      for (let n = 1; n <= 8; n++) {
        await sweepOnce(schedule.id);
        const view = dataOf<ScheduleBody>(
          await h.getSchedule(sender.userId, schedule.id).expect(200),
        );
        expect(view.nextRunDate).toBe(monthsAfter(anchor, n));
      }
    });

    it('completes after the last run on or before end_date', async () => {
      const { sender, schedule } = await seedSchedule({
        startDate: addDays(tomorrow(), 1),
        interval: { unit: 'week', count: 1 },
        endDate: addDays(tomorrow(), 1 + 14),
      });

      await sweepOnce(schedule.id);
      await sweepOnce(schedule.id);
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('active');
      const last = await sweepOnce(schedule.id);

      expect(last.status).toBe('completed');
      expect(last.nextRunAt).toBeNull();
      expect(await changeKindsOf(schedule.id)).toEqual([
        'created',
        'completed',
      ]);
      const view = dataOf<ScheduleBody>(
        await h.getSchedule(sender.userId, schedule.id).expect(200),
      );
      expect(view).toMatchObject({
        status: 'completed',
        runsUsed: 3,
        nextRunDate: null,
        nextRunAt: null,
      });

      await h.engine().sweep();
      expect(await h.runsOf(schedule.id)).toHaveLength(3);
      await h.cancelSchedule(sender.userId, schedule.id).expect(409);
    });

    it('completes when the next date would pass end_date', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'week', count: 1 },
        endDate: addDays(tomorrow(), 10),
      });

      await sweepOnce(schedule.id);
      const second = await sweepOnce(schedule.id);

      expect(second.status).toBe('completed');
      expect(await h.runsOf(schedule.id)).toHaveLength(2);
    });

    it('completes a single-run schedule on the first sweep when end_date equals start', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
        endDate: tomorrow(),
      });

      const swept = await sweepOnce(schedule.id);

      expect(swept.status).toBe('completed');
      expect(await h.runsOf(schedule.id)).toHaveLength(1);
    });

    it('stops at max_runs', async () => {
      const { sender, schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
        maxRuns: 3,
      });

      await sweepOnce(schedule.id);
      await h.waitForRunEnd(schedule.id);
      expect((await h.runsOf(schedule.id))[0].status).toBe('succeeded');
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('active');

      await sweepOnce(schedule.id);
      const last = await sweepOnce(schedule.id);

      expect(last.status).toBe('completed');
      expect(await h.runsOf(schedule.id)).toHaveLength(3);
      expect(await changeKindsOf(schedule.id)).toEqual([
        'created',
        'completed',
      ]);
      const view = dataOf<ScheduleBody>(
        await h.getSchedule(sender.userId, schedule.id).expect(200),
      );
      expect(view).toMatchObject({
        maxRuns: 3,
        runsUsed: 3,
        nextRunDate: null,
      });
    });

    it('completes a max_runs 1 schedule on its first sweep', async () => {
      const { schedule } = await seedSchedule({
        interval: { unit: 'month', count: 1 },
        maxRuns: 1,
      });

      expect((await sweepOnce(schedule.id)).status).toBe('completed');
    });

    describe('while the last run has not ended', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      // Keeps the worker from picking the run up, so it stays pending.
      async function sweepLastRunWithoutWorker(body: Record<string, unknown>) {
        const seeded = await seedSchedule(body);
        const queue = ctx.app.get<Queue>(
          getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE),
        );
        jest.spyOn(queue, 'addBulk').mockResolvedValue([]);
        await h.makeDue(seeded.schedule.id);
        await h.engine().sweep();
        return seeded;
      }

      it.each([
        ['max_runs', { maxRuns: 1 }],
        ['end_date', { endDate: tomorrow() }],
      ])(
        'completes an exhausted %s schedule only once its last run ends',
        async (_label, endCondition) => {
          const { schedule } = await sweepLastRunWithoutWorker({
            interval: { unit: 'day', count: 1 },
            ...endCondition,
          });

          const waiting = await h
            .scheduleRepo()
            .findOneByOrFail({ id: schedule.id });
          expect(waiting.status).toBe('active');
          expect(waiting.nextRunAt).toBeNull();
          expect(await changeKindsOf(schedule.id)).toEqual(['created']);

          const [run] = await h.runsOf(schedule.id);
          await h.engine().executeRun(run.id);

          const done = await h
            .scheduleRepo()
            .findOneByOrFail({ id: schedule.id });
          expect(done.status).toBe('completed');
          expect(await changeKindsOf(schedule.id)).toEqual([
            'created',
            'completed',
          ]);
        },
      );

      it('can cancel a recurring schedule while its last run is pending', async () => {
        const { sender, schedule } = await sweepLastRunWithoutWorker({
          interval: { unit: 'day', count: 1 },
          maxRuns: 1,
        });

        const res = await h
          .cancelSchedule(sender.userId, schedule.id)
          .expect(201);

        expect(dataOf<ScheduleBody>(res).status).toBe('cancelled');
        expect((await h.runsOf(schedule.id))[0].status).toBe('cancelled');
        expect(await changeKindsOf(schedule.id)).toEqual([
          'created',
          'cancelled',
        ]);
      });

      it('lists the schedule as active until the last run ends', async () => {
        const { sender, schedule } = await sweepLastRunWithoutWorker({
          interval: { unit: 'day', count: 1 },
          maxRuns: 1,
        });

        const active = dataOf<{ items: ScheduleBody[] }>(
          await h.listSchedules(sender.userId, '?status=active').expect(200),
        );
        const ended = dataOf<{ items: ScheduleBody[] }>(
          await h.listSchedules(sender.userId, '?status=ended').expect(200),
        );

        expect(active.items.map((i) => i.id)).toEqual([schedule.id]);
        expect(ended.items).toEqual([]);
      });
    });

    it('keeps a cancelled recurring schedule from advancing', async () => {
      const { sender, schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
      });
      await h.makeDue(schedule.id);
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);

      await h.engine().sweep();

      expect(await h.runsOf(schedule.id)).toHaveLength(0);
    });
  });

  describe('list', () => {
    async function seedOwner(count: number) {
      const sender = await h.seedUser('owner', { balanceMinor: 1_000_000n });
      const recipient = await h.seedUser('recipient');
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const created = dataOf<ScheduleBody>(
          await h.createSchedule(sender.userId, recipient.userId).expect(201),
        );
        ids.push(created.id);
      }
      return { sender, recipient, ids };
    }

    const pageOf = (res: { body: unknown }) =>
      dataOf<{ items: ScheduleBody[]; nextCursor: string | null }>(res);

    it('pages newest first with no gaps or repeats', async () => {
      const { sender, ids } = await seedOwner(5);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const page = pageOf(
          await h.listSchedules(sender.userId, query).expect(200),
        );
        seen.push(...page.items.map((s) => s.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('defaults to 20 and returns no cursor on the last page', async () => {
      const { sender } = await seedOwner(3);

      const page = pageOf(await h.listSchedules(sender.userId).expect(200));

      expect(page.items).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });

    it('filters active and ended, and ended covers cancelled and completed', async () => {
      const { sender, recipient, ids } = await seedOwner(3);
      await h.cancelSchedule(sender.userId, ids[0]).expect(201);
      const completed = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, {
            interval: { unit: 'day', count: 1 },
            maxRuns: 1,
          })
          .expect(201),
      );
      await sweepOnce(completed.id);

      const active = pageOf(
        await h.listSchedules(sender.userId, '?status=active').expect(200),
      );
      const ended = pageOf(
        await h.listSchedules(sender.userId, '?status=ended').expect(200),
      );
      const all = pageOf(await h.listSchedules(sender.userId).expect(200));

      expect(active.items.map((s) => s.id).sort()).toEqual(
        [ids[1], ids[2]].sort(),
      );
      expect(ended.items.map((s) => s.id).sort()).toEqual(
        [ids[0], completed.id].sort(),
      );
      expect(ended.items.map((s) => s.status).sort()).toEqual([
        'cancelled',
        'completed',
      ]);
      expect(all.items).toHaveLength(4);
    });

    it('lists only the caller own schedules', async () => {
      const { ids } = await seedOwner(2);
      const stranger = await h.seedUser('stranger');

      const page = pageOf(await h.listSchedules(stranger.userId).expect(200));

      expect(page.items).toEqual([]);
      expect(ids).toHaveLength(2);
    });

    it('rejects a bad filter, a limit over 50, and a forged cursor', async () => {
      const { sender } = await seedOwner(1);

      await h.listSchedules(sender.userId, '?status=bogus').expect(400);
      await h.listSchedules(sender.userId, '?limit=51').expect(400);
      await h.listSchedules(sender.userId, '?limit=0').expect(400);
      await h.listSchedules(sender.userId, '?cursor=garbage').expect(400);
      await h.listSchedules(sender.userId, '?limit=50').expect(200);
    });

    it('shows the interval, end condition, runs used and next run', async () => {
      const sender = await h.seedUser('owner', { balanceMinor: 1_000_000n });
      const recipient = await h.seedUser('recipient');
      const created = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, {
            interval: { unit: 'month', count: 3 },
            endDate: addDays(tomorrow(), 300),
          })
          .expect(201),
      );

      const page = pageOf(await h.listSchedules(sender.userId).expect(200));

      expect(page.items[0]).toMatchObject({
        id: created.id,
        interval: { unit: 'month', count: 3 },
        endDate: addDays(tomorrow(), 300),
        maxRuns: null,
        runsUsed: 0,
        nextRunDate: tomorrow(),
      });
    });
  });
});
