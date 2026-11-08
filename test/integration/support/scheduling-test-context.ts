import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulingModule } from '../../../src/modules/scheduling/scheduling.module';
import { RunEngine } from '../../../src/modules/scheduling/internal/run-engine.service';
import {
  SCHEDULED_PAYMENT_RUNS_QUEUE,
  SCHEDULED_PAYMENT_SWEEP_QUEUE,
} from '../../../src/modules/scheduling/internal/queues';
import { ScheduledPayment } from '../../../src/modules/scheduling/entities/scheduled-payment.entity';
import { ScheduledPaymentRun } from '../../../src/modules/scheduling/entities/scheduled-payment-run.entity';
import { KycTier } from '../../../src/modules/users/users.service';
import { DOMAIN_EVENTS_QUEUE } from '../../../src/shared/events/event-bus.service';
import { CHANNEL_DISPATCH_QUEUE } from '../../../src/modules/notifications/internal/channel-dispatch.queue';
import {
  TransfersTestContext,
  createTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './transfers-test-context';
import {
  addDays,
  computeDueAt,
  lagosToday,
} from '../../../src/modules/scheduling/internal/run-time';
import { waitFor } from './social-blocks-test-helpers';
import { createHmac } from 'crypto';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import { PAYMENT_PROVIDER_ADAPTER } from '../../../src/modules/payments/adapters/payment-provider.interface';
import { FakeAdapter } from '../../../src/modules/payments/adapters/fake.adapter';
import { BankAccount } from '../../../src/modules/withdrawals/entities/bank-account.entity';
import { seedBankAccount } from './withdrawals-test-context';
import { Money } from '../../../src/shared/primitives/money';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export interface ScheduleUser {
  userId: string;
  walletId: string;
  email: string;
  username: string;
}

export interface ScheduleBody {
  id: string;
  target: { type: string; userId?: string; bankAccountId?: string };
  amount: { amount: string; currency: string };
  note: string | null;
  visibility: string | null;
  fees: {
    platform: { amount: string; currency: string };
    provider: { amount: string; currency: string };
  } | null;
  interval: { unit: string; count: number } | null;
  endDate: string | null;
  maxRuns: number | null;
  runsUsed: number;
  status: string;
  consecutiveFailures: number;
  pausedReason: string | null;
  nextRunDate: string | null;
  nextRunAt: string | null;
}

export async function createSchedulingTestContext() {
  const ctx = await createTransfersTestContext(0, [SchedulingModule]);
  // BullMQ runs an `every` scheduler's first job at once. Let that boot tick
  // finish, with nothing to sweep yet, before any test seeds data.
  const sweepQueue = ctx.app.get<Queue>(
    getQueueToken(SCHEDULED_PAYMENT_SWEEP_QUEUE),
    { strict: false },
  );
  await waitFor(async () => {
    const counts = await sweepQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
    );
    return counts.waiting + counts.active === 0 && counts.delayed > 0;
  });
  return ctx;
}

export function tomorrow(): string {
  return addDays(lagosToday(new Date()), 1);
}

export const lagosAt = (date: string, time: string) =>
  computeDueAt(date, time, 0);

// Fakes only Date, so queries, timers and the worker keep running while the
// engine believes it is a given moment.
export async function atClock<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  try {
    return await fn();
  } finally {
    jest.useRealTimers();
  }
}

export function createSchedulingHelpers(getCtx: () => TransfersTestContext) {
  const jwtService = new JwtService({ secret: JWT_SECRET });
  let idSeq = 0;

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  const http = () => request(getCtx().app.getHttpServer());

  async function seedUser(
    prefix: string,
    options: { kycTier?: KycTier; balanceMinor?: bigint } = {},
  ): Promise<ScheduleUser> {
    idSeq += 1;
    const n = idSeq;
    const username = `${prefix}_sched_${n}`;
    const email = `${prefix}-sched-${n}@example.com`;
    const user = await seedTransferUser(getCtx(), {
      email,
      phone: `+2348055${String(700_000 + n).padStart(6, '0')}`,
      username,
      kycTier: options.kycTier,
    });
    if (options.balanceMinor) {
      await fundWallet(getCtx(), {
        reference: `cliqpay-sched-fund-${user.userId}`,
        walletId: user.walletId,
        netAmountMinor: options.balanceMinor,
      });
    }
    return { ...user, email, username };
  }

  function createSchedule(
    userId: string,
    recipientUserId: string,
    body: Record<string, unknown> = {},
  ): request.Test {
    return http()
      .post('/scheduled-payments')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({
        reference: `sched-ref-${randomUUID()}`,
        target: { type: 'user', userId: recipientUserId },
        amount: 100_000,
        startDate: tomorrow(),
        visibility: 'private',
        pin: '1234',
        ...body,
      });
  }

  function createBankSchedule(
    userId: string,
    bankAccountId: string,
    body: Record<string, unknown> = {},
  ): request.Test {
    return http()
      .post('/scheduled-payments')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({
        reference: `sched-ref-${randomUUID()}`,
        target: { type: 'bank_account', bankAccountId },
        amount: 100_000,
        startDate: tomorrow(),
        pin: '1234',
        ...body,
      });
  }

  let bankSeq = 0;
  function seedBank(
    userId: string,
    overrides: { bankName?: string; accountNumber?: string } = {},
  ) {
    bankSeq += 1;
    return seedBankAccount(
      { bankAccountRepo: getCtx().dataSource.getRepository(BankAccount) },
      {
        userId,
        accountNumber:
          overrides.accountNumber ?? `0123${String(bankSeq).padStart(6, '0')}`,
        bankName: overrides.bankName,
      },
    );
  }

  const fakeAdapter = () =>
    getCtx().app.get<FakeAdapter>(PAYMENT_PROVIDER_ADAPTER, { strict: false });

  // Delivers Kora's payout webhook for a withdrawal reference, so the
  // settlement runs through the real completion and reversal paths.
  async function settlePayout(
    reference: string,
    status: 'success' | 'failed',
    amountMinor: bigint,
  ): Promise<void> {
    const data = {
      reference,
      status,
      amount: Money.of(amountMinor, 'NGN').toDecimalString(),
      ...(status === 'failed' ? { message: 'Bank declined' } : {}),
    };
    const event = status === 'failed' ? 'transfer.failed' : 'transfer.success';
    const signature = createHmac('sha256', 'fake-kora-secret-key')
      .update(JSON.stringify(data))
      .digest('hex');
    await getCtx()
      .app.get(PaymentsService, { strict: false })
      .handleKoraWebhook(
        Buffer.from(JSON.stringify({ event, data })),
        signature,
      );
  }

  const getSchedule = (userId: string, id: string) =>
    http()
      .get(`/scheduled-payments/${id}`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);

  const listSchedules = (userId: string, query = '') =>
    http()
      .get(`/scheduled-payments${query}`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);

  const cancelSchedule = (userId: string, id: string) =>
    http()
      .post(`/scheduled-payments/${id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);

  const pauseSchedule = (userId: string, id: string) =>
    http()
      .post(`/scheduled-payments/${id}/pause`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);

  const resumeSchedule = (
    userId: string,
    id: string,
    body: Record<string, unknown> = { pin: '1234' },
  ) =>
    http()
      .post(`/scheduled-payments/${id}/resume`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send(body);

  const listRuns = (userId: string, id: string, query = '') =>
    http()
      .get(`/scheduled-payments/${id}/runs${query}`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);

  const engine = () => getCtx().app.get(RunEngine, { strict: false });

  const scheduleRepo = () =>
    getCtx().dataSource.getRepository(ScheduledPayment);
  const runRepo = () => getCtx().dataSource.getRepository(ScheduledPaymentRun);

  async function makeDue(scheduleId: string): Promise<void> {
    await getCtx().dataSource.query(
      `UPDATE scheduled_payments SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [scheduleId],
    );
  }

  async function runsOf(scheduleId: string): Promise<ScheduledPaymentRun[]> {
    return runRepo().find({
      where: { scheduledPaymentId: scheduleId },
      order: { runNumber: 'ASC' },
    });
  }

  async function waitForRunEnd(
    scheduleId: string,
  ): Promise<ScheduledPaymentRun> {
    await waitFor(async () => {
      const runs = await runsOf(scheduleId);
      return runs.length > 0 && runs.every((r) => r.status !== 'pending');
    }, 20_000);
    return (await runsOf(scheduleId))[0];
  }

  async function waitForQueuesDrained(): Promise<void> {
    const queues = [
      DOMAIN_EVENTS_QUEUE,
      CHANNEL_DISPATCH_QUEUE,
      SCHEDULED_PAYMENT_RUNS_QUEUE,
    ].map((name) => getCtx().app.get<Queue>(getQueueToken(name)));
    await waitFor(async () => {
      for (const queue of queues) {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'prioritized',
        );
        if (Object.values(counts).some((count) => count > 0)) {
          return false;
        }
      }
      return true;
    }, 20_000);
  }

  return {
    tokenFor,
    http,
    seedUser,
    createSchedule,
    createBankSchedule,
    seedBank,
    fakeAdapter,
    settlePayout,
    getSchedule,
    listSchedules,
    cancelSchedule,
    pauseSchedule,
    resumeSchedule,
    listRuns,
    engine,
    scheduleRepo,
    runRepo,
    makeDue,
    runsOf,
    waitForRunEnd,
    waitForQueuesDrained,
  };
}
