import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DOMAIN_EVENTS_QUEUE } from '../../../src/shared/events/event-bus.service';
import { BILL_SPLIT_EVENTS_QUEUE } from '../../../src/modules/billsplit/internal/bill-split-events.queue';
import { waitFor } from './social-blocks-test-helpers';
import { BillSplitModule } from '../../../src/modules/billsplit/billsplit.module';
import { KycTier } from '../../../src/modules/users/users.service';
import {
  TransfersTestContext,
  createTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './transfers-test-context';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export interface SplitUser {
  userId: string;
  walletId: string;
  username: string;
}

export interface SplitBody {
  id: string;
  description: string;
  mode: string;
  total: { amount: string; currency: string };
  initiatorShare: { amount: string; currency: string };
  initiator: { userId: string };
  status: string;
  visibility: string;
  expiresAt: string;
  participants: {
    userId: string;
    username: string;
    share: { amount: string; currency: string };
    moneyRequestId: string;
    status: string;
  }[];
}

export function createBillSplitTestContext() {
  return createTransfersTestContext(0, [BillSplitModule]);
}

export function createBillSplitHelpers(getCtx: () => TransfersTestContext) {
  const jwtService = new JwtService({ secret: JWT_SECRET });
  let idSeq = 0;

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  function http() {
    return request(getCtx().app.getHttpServer());
  }

  async function seedUser(
    prefix: string,
    options: { kycTier?: KycTier; balanceMinor?: bigint } = {},
  ): Promise<SplitUser> {
    idSeq += 1;
    const n = idSeq;
    const username = `${prefix}_split_${n}`;
    const user = await seedTransferUser(getCtx(), {
      email: `${prefix}-split-${n}@example.com`,
      phone: `+2348077${String(600_000 + n).padStart(6, '0')}`,
      username,
      kycTier: options.kycTier,
    });
    if (options.balanceMinor) {
      await fundWallet(getCtx(), {
        reference: `cliqpay-split-fund-${user.userId}`,
        walletId: user.walletId,
        netAmountMinor: options.balanceMinor,
      });
    }
    return { ...user, username };
  }

  function createSplit(
    initiatorId: string,
    body: Record<string, unknown>,
  ): request.Test {
    return http()
      .post('/bill-splits')
      .set('Authorization', `Bearer ${tokenFor(initiatorId)}`)
      .send({
        reference: `split-ref-${randomUUID()}`,
        description: 'Dinner',
        mode: 'equal',
        total: 100_000,
        visibility: 'private',
        ...body,
      });
  }

  function getSplit(viewerId: string, splitId: string): request.Test {
    return http()
      .get(`/bill-splits/${splitId}`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  function payRequest(
    payerId: string,
    moneyRequestId: string,
    body: Record<string, unknown> = {},
  ): request.Test {
    return http()
      .post(`/money-requests/${moneyRequestId}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .send({ reference: `pay-ref-${randomUUID()}`, pin: '1234', ...body });
  }

  // Domain events first, then the split subscriber's queue: fan-out enqueues
  // onto the second before finishing the first, so both empty means every
  // published event has been handled.
  async function waitForSplitEventsProcessed(): Promise<void> {
    for (const name of [DOMAIN_EVENTS_QUEUE, BILL_SPLIT_EVENTS_QUEUE]) {
      const queue = getCtx().app.get<Queue>(getQueueToken(name));
      await waitFor(async () => {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'prioritized',
        );
        return Object.values(counts).every((count) => count === 0);
      });
    }
  }

  return {
    tokenFor,
    http,
    seedUser,
    createSplit,
    getSplit,
    payRequest,
    waitForSplitEventsProcessed,
  };
}
