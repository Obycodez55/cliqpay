import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TransfersTestContext } from './transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  atClock,
  createSchedulingHelpers,
  lagosAt,
} from './scheduling-test-context';
import { dataOf } from './api-response';
import { waitFor } from './social-blocks-test-helpers';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../../src/modules/scheduling/internal/queues';
import {
  addDays,
  lagosToday,
} from '../../../src/modules/scheduling/internal/run-time';
import { ScheduledPaymentAttempt } from '../../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentRun } from '../../../src/modules/scheduling/entities/scheduled-payment-run.entity';

export const HOUR_MS = 3_600_000;
export const AMOUNT = 100_000n;
export const FEE = 3_000n;

export function createBankRunHelpers(getCtx: () => TransfersTestContext) {
  const h = createSchedulingHelpers(getCtx);
  const queue = () =>
    getCtx().app.get<Queue>(getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE));

  async function seedSchedule(
    options: { body?: Record<string, unknown>; balanceMinor?: bigint } = {},
  ) {
    const sender = await h.seedUser('sender', {
      balanceMinor: options.balanceMinor ?? 5_000_000n,
    });
    const bank = await h.seedBank(sender.userId, {
      bankName: 'GTBank',
      accountNumber: '0123454821',
    });
    const schedule = dataOf<ScheduleBody>(
      await h
        .createBankSchedule(sender.userId, bank.id, options.body)
        .expect(201),
    );
    return { sender, bank, schedule };
  }

  const daily = { interval: { unit: 'day', count: 1 } };
  const date = () => addDays(lagosToday(new Date()), 10);
  const nightOf = (hours: number, d = date()) =>
    new Date(lagosAt(d, '08:00').getTime() + hours * HOUR_MS);

  async function insertRun(
    scheduleId: string,
    runNumber = 1,
    options: { keepNextRun?: boolean } = {},
  ) {
    if (!options.keepNextRun) {
      await h.scheduleRepo().update({ id: scheduleId }, { nextRunAt: null });
    }
    if (options.keepNextRun) {
      await h
        .scheduleRepo()
        .update({ id: scheduleId }, { nextRunNumber: runNumber + 1 });
    }
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber,
        dueAt: lagosAt(date(), '06:00'),
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: null,
        bankAccountId: schedule.bankAccountId,
        note: schedule.note,
        visibility: null,
      }),
    );
  }

  const execute = (run: ScheduledPaymentRun, at = nightOf(0)) =>
    atClock(at, () => h.engine().executeRun(run.id));
  const reload = (runId: string) => h.runRepo().findOneByOrFail({ id: runId });
  const scheduleOf = (id: string) => h.scheduleRepo().findOneByOrFail({ id });
  const attemptsOf = (runId: string) =>
    getCtx()
      .dataSource.getRepository(ScheduledPaymentAttempt)
      .find({
        where: { runId },
        order: { attemptNumber: 'ASC', createdAt: 'ASC' },
      });
  const balanceOf = async (user: ScheduleUser) =>
    (await getCtx().accountRepo.findOneByOrFail({ id: user.walletId })).balance;
  const notificationsOf = (user: ScheduleUser, type: string) =>
    getCtx().notificationRepo.findBy({ userId: user.userId, type });
  const refOf = (scheduleId: string, run: number, attempt: number) =>
    `sched_${scheduleId}_${run}_${attempt}`;

  const rejectNextPayout = () =>
    jest.spyOn(h.fakeAdapter(), 'initiatePayout').mockResolvedValueOnce({
      status: 'rejected',
      reason: 'Invalid bank provided.',
    });

  async function waitForStatus(runId: string, status: string) {
    await waitFor(async () => (await reload(runId)).status === status, 20_000);
  }

  return {
    h,
    queue,
    seedSchedule,
    daily,
    date,
    nightOf,
    insertRun,
    execute,
    reload,
    scheduleOf,
    attemptsOf,
    balanceOf,
    notificationsOf,
    refOf,
    rejectNextPayout,
    waitForStatus,
  };
}
