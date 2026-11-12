import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TransfersTestContext, fundWallet } from './transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  atClock,
  createSchedulingHelpers,
  lagosAt,
} from './scheduling-test-context';
import { dataOf } from './api-response';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../../src/modules/scheduling/internal/queues';
import { lagosToday } from '../../../src/modules/scheduling/internal/run-time';
import { ScheduledPaymentAttempt } from '../../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from '../../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { ScheduledPaymentRun } from '../../../src/modules/scheduling/entities/scheduled-payment-run.entity';

export const HOUR_MS = 3_600_000;

export function createFailureHelpers(getCtx: () => TransfersTestContext) {
  const h = createSchedulingHelpers(getCtx);
  const queue = () =>
    getCtx().app.get<Queue>(getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE));

  const hoursAfter = (from: Date, hours: number) =>
    new Date(from.getTime() + hours * HOUR_MS);

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
          riskAcknowledged: true,
          ...options.body,
        })
        .expect(201),
    );
    return { sender, recipient, schedule };
  }

  const daily = { interval: { unit: 'day', count: 1 } };

  async function insertRun(scheduleId: string, dueAt: Date) {
    await h.scheduleRepo().update({ id: scheduleId }, { nextRunAt: null });
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber: 1,
        dueAt,
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: schedule.recipientUserId,
        note: schedule.note,
        visibility: schedule.visibility,
      }),
    );
  }

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

  // The first attempt of a run lands at 23:30 Lagos on its date, so a
  // transient failure has no retry left in the day and ends the run.
  async function executeAtNightfall(run: ScheduledPaymentRun) {
    await atClock(lagosAt(lagosToday(run.dueAt), '23:30'), () =>
      execute(run.id),
    );
    return h.runRepo().findOneByOrFail({ id: run.id });
  }

  const reload = (runId: string) => h.runRepo().findOneByOrFail({ id: runId });

  const attemptsOf = (runId: string) =>
    getCtx()
      .dataSource.getRepository(ScheduledPaymentAttempt)
      .find({ where: { runId }, order: { attemptNumber: 'ASC' } });

  const changesOf = (scheduleId: string) =>
    getCtx()
      .dataSource.getRepository(ScheduledPaymentChange)
      .find({
        where: { scheduledPaymentId: scheduleId },
        order: { createdAt: 'ASC' },
      });

  const notificationsOf = (user: ScheduleUser, type: string) =>
    getCtx().notificationRepo.findBy({ userId: user.userId, type });

  const topUp = (user: ScheduleUser, amount: bigint) =>
    fundWallet(getCtx(), {
      reference: `topup-${randomUUID()}`,
      walletId: user.walletId,
      netAmountMinor: amount,
    });

  const view = async (user: ScheduleUser, scheduleId: string) =>
    dataOf<ScheduleBody>(
      await h.getSchedule(user.userId, scheduleId).expect(200),
    );

  async function blockSender(sender: ScheduleUser, recipient: ScheduleUser) {
    await h
      .http()
      .put(`/social/blocks/${sender.userId}`)
      .set('Authorization', `Bearer ${h.tokenFor(recipient.userId)}`)
      .expect(200);
  }

  return {
    h,
    queue,
    hoursAfter,
    seedSchedule,
    daily,
    insertRun,
    claimRun,
    execute,
    executeAtNightfall,
    reload,
    attemptsOf,
    changesOf,
    notificationsOf,
    topUp,
    view,
    blockSender,
  };
}
