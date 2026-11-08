import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  createSchedulingHelpers,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';

jest.setTimeout(180_000);

interface HistoryItem {
  reference: string | null;
  type: string;
  direction: string | null;
}

interface RunsBody {
  items: {
    status: string;
    attempts: { failureCode: string | null }[];
  }[];
}

describe('What a scheduled payment reveals', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSchedule(body: Record<string, unknown> = {}) {
    const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId, body).expect(201),
    );
    return { sender, recipient, schedule };
  }

  async function sweepAndWait(scheduleId: string) {
    await h.makeDue(scheduleId);
    await h.engine().sweep();
    const run = await h.waitForRunEnd(scheduleId);
    await h.waitForQueuesDrained();
    return run;
  }

  const historyOf = async (user: ScheduleUser) =>
    dataOf<{ items: HistoryItem[] }>(
      await h
        .http()
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${h.tokenFor(user.userId)}`)
        .expect(200),
    ).items;

  describe('the sched_ reference', () => {
    it('is null in the recipient’s history and still shown to the sender', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      await sweepAndWait(schedule.id);
      const reference = `sched_${schedule.id}_1_1`;

      const senderItems = (await historyOf(sender)).filter(
        (item) => item.type === 'p2p_transfer',
      );
      const recipientItems = (await historyOf(recipient)).filter(
        (item) => item.type === 'p2p_transfer',
      );

      expect(senderItems).toEqual([
        expect.objectContaining({ reference, direction: 'debit' }),
      ]);
      expect(recipientItems).toEqual([
        expect.objectContaining({ reference: null, direction: 'credit' }),
      ]);
      expect(JSON.stringify(recipientItems)).not.toMatch(/sched_[0-9a-f-]{36}/);
    });

    it('leaves the reference of a live transfer visible to the recipient', async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      const reference = `live-${randomUUID()}`;
      await h
        .http()
        .post('/transfers')
        .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
        .send({
          recipientUserId: recipient.userId,
          amount: 100_000,
          reference,
          visibility: 'private',
          pin: '1234',
        })
        .expect(201);

      const items = await historyOf(recipient);

      expect(
        items.find((item) => item.type === 'p2p_transfer')?.reference,
      ).toBe(reference);
    });

    it('never reaches the recipient through the transfer_received notification', async () => {
      const { recipient, schedule } = await seedSchedule();
      await sweepAndWait(schedule.id);
      await waitFor(
        async () =>
          (
            await ctx.notificationRepo.findBy({
              userId: recipient.userId,
              type: 'transfer_received',
            })
          ).length === 1,
      );

      const [notification] = await ctx.notificationRepo.findBy({
        userId: recipient.userId,
        type: 'transfer_received',
      });

      expect(
        JSON.stringify([
          notification.title,
          notification.body,
          notification.data,
        ]),
      ).not.toMatch(/sched_[0-9a-f-]{36}/);
    });
  });

  describe('a block', () => {
    async function blockedRun() {
      const { sender, recipient, schedule } = await seedSchedule({
        interval: { unit: 'day', count: 1 },
      });
      await h
        .http()
        .put(`/social/blocks/${sender.userId}`)
        .set('Authorization', `Bearer ${h.tokenFor(recipient.userId)}`)
        .expect(200);
      await sweepAndWait(schedule.id);
      return { sender, schedule };
    }

    it('reads as recipient_unable_to_receive on the runs endpoint and the schedule, while the database keeps blocked', async () => {
      const { sender, schedule } = await blockedRun();

      const runs = dataOf<RunsBody>(
        await h.listRuns(sender.userId, schedule.id).expect(200),
      );
      const view = dataOf<ScheduleBody>(
        await h.getSchedule(sender.userId, schedule.id).expect(200),
      );
      const list = dataOf<{ items: ScheduleBody[] }>(
        await h.listSchedules(sender.userId).expect(200),
      );

      expect(runs.items[0].status).toBe('failed');
      expect(runs.items[0].attempts[0].failureCode).toBe(
        'recipient_unable_to_receive',
      );
      expect(view).toMatchObject({
        status: 'paused',
        pausedReason: 'recipient_unable_to_receive',
      });
      expect(list.items[0].pausedReason).toBe('recipient_unable_to_receive');
      expect(JSON.stringify([runs, view, list])).not.toMatch(/block/i);
      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row.pausedReason).toBe('blocked');
      const [attempt] = await ctx.dataSource.query<{ failure_code: string }[]>(
        `SELECT failure_code FROM scheduled_payment_attempts WHERE reference = $1`,
        [`sched_${schedule.id}_1_1`],
      );
      expect(attempt.failure_code).toBe('blocked');
    });

    it('is worded the same in the failed and paused notifications', async () => {
      const { sender } = await blockedRun();
      await waitFor(async () => {
        const failed = await ctx.notificationRepo.findBy({
          userId: sender.userId,
          type: 'scheduled_payment_run_failed',
        });
        const paused = await ctx.notificationRepo.findBy({
          userId: sender.userId,
          type: 'scheduled_payment_paused',
        });
        return failed.length === 1 && paused.length === 1;
      });

      const notifications = await ctx.notificationRepo.findBy({
        userId: sender.userId,
      });
      const failed = notifications.find(
        (n) => n.type === 'scheduled_payment_run_failed',
      )!;
      const paused = notifications.find(
        (n) => n.type === 'scheduled_payment_paused',
      )!;

      for (const note of [failed, paused]) {
        expect(note.data).toMatchObject({
          reason: 'recipient_unable_to_receive',
        });
        expect(note.body).toContain(
          "the recipient can't receive this payment right now",
        );
        expect(JSON.stringify(note)).not.toMatch(/block/i);
      }
      await h.waitForQueuesDrained();
      for (const mail of ctx.emailAdapter.sent.filter(
        (m) => m.to === sender.email,
      )) {
        expect(JSON.stringify(mail)).not.toMatch(/blocked/i);
      }
    });
  });
});
