import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './transfers-test-context';
import { KycTier } from '../../../src/modules/users/users.service';
import { DOMAIN_EVENTS_QUEUE } from '../../../src/shared/events/event-bus.service';
import { CHANNEL_DISPATCH_QUEUE } from '../../../src/modules/notifications/internal/channel-dispatch.queue';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export interface SeededUser {
  userId: string;
  walletId: string;
}

// Each case runs with A blocking B and again with B blocking A, so the
// assertions hold whichever side created the block.
export const BLOCK_DIRECTIONS = [
  { name: 'the first user blocked the second', blockerIndex: 0 },
  { name: 'the second user blocked the first', blockerIndex: 1 },
] as const;

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function expectNoBlockedWording(res: { body: unknown }): void {
  expect(JSON.stringify(res.body)).not.toMatch(/block/i);
}

export function createSocialBlocksTestHelpers(
  getCtx: () => TransfersTestContext,
) {
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
    kycTier: KycTier = 'tier1',
  ): Promise<SeededUser> {
    idSeq += 1;
    const n = idSeq;
    return seedTransferUser(getCtx(), {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348066${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_block_${n}`,
      kycTier,
    });
  }

  async function seedFunded(prefix: string): Promise<SeededUser> {
    const user = await seedUser(prefix, 'tier3');
    await fundWallet(getCtx(), {
      reference: `cliqpay-block-fund-${user.userId}`,
      walletId: user.walletId,
      netAmountMinor: 10_000_000n,
    });
    return user;
  }

  function block(blockerId: string, blockedId: string) {
    return http()
      .put(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`);
  }

  function unblock(blockerId: string, blockedId: string) {
    return http()
      .delete(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`);
  }

  function follow(followerId: string, followeeId: string) {
    return http()
      .put(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`);
  }

  async function blockBetween(
    users: [SeededUser, SeededUser],
    blockerIndex: 0 | 1,
  ): Promise<void> {
    const blocker = users[blockerIndex];
    const blocked = users[1 - blockerIndex];
    await block(blocker.userId, blocked.userId).expect(200);
  }

  async function waitForQueuesDrained(): Promise<void> {
    const queues = [DOMAIN_EVENTS_QUEUE, CHANNEL_DISPATCH_QUEUE].map((name) =>
      getCtx().app.get<Queue>(getQueueToken(name)),
    );
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
    });
  }

  return {
    tokenFor,
    http,
    seedUser,
    seedFunded,
    block,
    unblock,
    follow,
    blockBetween,
    waitForQueuesDrained,
  };
}
