import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulingModule } from '../../../src/modules/scheduling/scheduling.module';
import { RunEngine } from '../../../src/modules/scheduling/internal/run-engine.service';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../../src/modules/scheduling/internal/queues';
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
  lagosToday,
} from '../../../src/modules/scheduling/internal/run-time';
import { waitFor } from './social-blocks-test-helpers';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export interface ScheduleUser {
  userId: string;
  walletId: string;
  email: string;
  username: string;
}

export interface ScheduleBody {
  id: string;
  target: { type: string; userId: string };
  amount: { amount: string; currency: string };
  note: string | null;
  visibility: string;
  interval: { unit: string; count: number } | null;
  endDate: string | null;
  maxRuns: number | null;
  runsUsed: number;
  status: string;
  nextRunDate: string | null;
  nextRunAt: string | null;
}

export function createSchedulingTestContext() {
  return createTransfersTestContext(0, [SchedulingModule]);
}

export function tomorrow(): string {
  return addDays(lagosToday(new Date()), 1);
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
    getSchedule,
    listSchedules,
    cancelSchedule,
    engine,
    scheduleRepo,
    runRepo,
    makeDue,
    runsOf,
    waitForRunEnd,
    waitForQueuesDrained,
  };
}
