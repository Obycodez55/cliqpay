import { createHash, randomUUID } from 'crypto';
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
import { dataOf } from './support/api-response';
import { describeSignedAction } from './support/signed-actions';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';

jest.setTimeout(180_000);

describe('device signatures on scheduled payments', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const scheduleCount = async (userId: string) =>
    (
      await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM scheduled_payments WHERE user_id = $1`,
        [userId],
      )
    ).length;

  describeSignedAction(
    'POST /scheduled-payments',
    () => ctx,
    { tamper: ['reference', 'amount', 'target'], replays: true },
    async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      const other = await h.seedUser('other');
      const reference = `sched-sig-${randomUUID()}`;
      const body = {
        reference,
        target: { type: 'user', userId: recipient.userId },
        amount: 100_000,
        startDate: tomorrow(),
        visibility: 'private',
        pin: '1234',
      };
      const post =
        (payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          h
            .http()
            .post('/scheduled-payments')
            .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
            .set(headers)
            .send(payload);
      return {
        userId: sender.userId,
        signs: {
          action: 'schedule.create',
          reference,
          amount: '100000',
          target: recipient.userId,
        },
        send: post(body),
        tampered: {
          reference: post({ ...body, reference: `${reference}-x` }),
          amount: post({ ...body, amount: 900_000 }),
          target: post({
            ...body,
            target: { type: 'user', userId: other.userId },
          }),
        },
        expectApplied: async () => {
          expect(await scheduleCount(sender.userId)).toBe(1);
        },
        expectUntouched: async () => {
          expect(await scheduleCount(sender.userId)).toBe(0);
        },
      };
    },
  );

  describeSignedAction(
    'PATCH /scheduled-payments/:id',
    () => ctx,
    { tamper: ['reference', 'amount', 'target'], replays: false },
    async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      const create = async () =>
        dataOf<ScheduleBody>(
          await h
            .createSchedule(sender.userId, recipient.userId, {
              startDate: addDays(lagosToday(new Date()), 3),
            })
            .expect(201),
        );
      ctx.config.device.keyRequired = false;
      let schedule: ScheduleBody;
      let decoy: ScheduleBody;
      try {
        schedule = await create();
        decoy = await create();
      } finally {
        ctx.config.device.keyRequired = true;
      }
      const body = {
        amount: 200_000,
        interval: { unit: 'day', count: 2 },
        pin: '1234',
      };
      const patch =
        (id: string, payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          h
            .http()
            .patch(`/scheduled-payments/${id}`)
            .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
            .set(headers)
            .send(payload);
      const amountOf = async (id: string) =>
        (await h.scheduleRepo().findOneByOrFail({ id })).amount;
      const originalAmount = await amountOf(schedule.id);
      return {
        userId: sender.userId,
        signs: {
          action: 'schedule.update',
          reference: createHash('sha256').update('day:2|||').digest('hex'),
          amount: '200000',
          target: schedule.id,
        },
        send: patch(schedule.id, body),
        tampered: {
          reference: patch(schedule.id, {
            ...body,
            interval: { unit: 'week', count: 1 },
          }),
          amount: patch(schedule.id, { ...body, amount: 900_000 }),
          target: patch(decoy.id, body),
        },
        expectApplied: async () => {
          expect(await amountOf(schedule.id)).toBe(200_000n);
        },
        expectUntouched: async () => {
          expect(await amountOf(schedule.id)).toBe(originalAmount);
          expect(await amountOf(decoy.id)).toBe(originalAmount);
        },
      };
    },
  );

  describeSignedAction(
    'POST /scheduled-payments/:id/resume',
    () => ctx,
    { tamper: ['target'], replays: false },
    async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      ctx.config.device.keyRequired = false;
      let schedule: ScheduleBody;
      let decoy: ScheduleBody;
      try {
        const make = async () => {
          const created = dataOf<ScheduleBody>(
            await h
              .createSchedule(sender.userId, recipient.userId, {
                startDate: addDays(lagosToday(new Date()), 3),
              })
              .expect(201),
          );
          await h.pauseSchedule(sender.userId, created.id).expect(201);
          return created;
        };
        schedule = await make();
        decoy = await make();
      } finally {
        ctx.config.device.keyRequired = true;
      }
      const statusOf = async (id: string) =>
        (await h.scheduleRepo().findOneByOrFail({ id })).status;
      const post = (id: string) => (headers: Record<string, string>) =>
        h
          .http()
          .post(`/scheduled-payments/${id}/resume`)
          .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
          .set(headers)
          .send({ pin: '1234' });
      return {
        userId: sender.userId,
        signs: {
          action: 'schedule.resume',
          reference: schedule.id,
          amount: '',
          target: schedule.id,
        },
        send: post(schedule.id),
        tampered: { target: post(decoy.id) },
        expectApplied: async () => {
          expect(await statusOf(schedule.id)).toBe('active');
        },
        expectUntouched: async () => {
          expect(await statusOf(schedule.id)).toBe('paused');
          expect(await statusOf(decoy.id)).toBe('paused');
        },
      };
    },
  );

  it('does not ask for a signature when an update changes only the note', async () => {
    const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId).expect(201),
    );
    ctx.config.device.keyRequired = true;
    try {
      await h
        .http()
        .patch(`/scheduled-payments/${schedule.id}`)
        .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
        .send({ note: 'Rent' })
        .expect(200);
    } finally {
      ctx.config.device.keyRequired = false;
    }
  });
});
