import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf } from './support/api-response';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/events/event-bus.service';
import { CHANNEL_DISPATCH_QUEUE } from '../../src/modules/notifications/internal/channel-dispatch.queue';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

async function waitFor(
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

interface MoneyRequestBody {
  id: string;
  counterparty: { userId: string };
  status: string;
}

interface MoneyRequestListBody {
  items: MoneyRequestBody[];
  nextCursor: string | null;
}

interface SeededUser {
  userId: string;
  walletId: string;
}

describe('Money-request soft filter', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(prefix: string): Promise<SeededUser> {
    idSeq += 1;
    const n = idSeq;
    return seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348077${String(700_000 + n).padStart(6, '0')}`,
      username: `${prefix}_soft_${n}`,
    });
  }

  function http() {
    return request(ctx.app.getHttpServer());
  }

  function follow(followerId: string, followeeId: string) {
    return http()
      .put(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`)
      .expect(200);
  }

  function unfollow(followerId: string, followeeId: string) {
    return http()
      .delete(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`)
      .expect(200);
  }

  function block(blockerId: string, blockedId: string) {
    return http()
      .put(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`)
      .expect(200);
  }

  async function createRequest(
    requesterId: string,
    payerId: string,
  ): Promise<MoneyRequestBody> {
    const res = await http()
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
      .send({ payerUserId: payerId, amount: 10_000 })
      .expect(201);
    return dataOf<MoneyRequestBody>(res);
  }

  async function listIncoming(
    payerId: string,
    query: Record<string, string | number> = {},
  ): Promise<MoneyRequestListBody> {
    const res = await http()
      .get('/money-requests/incoming')
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .expect(200);
    return dataOf<MoneyRequestListBody>(res);
  }

  async function incomingIds(
    payerId: string,
    bucket?: 'following' | 'others',
  ): Promise<string[]> {
    const page = await listIncoming(payerId, bucket ? { bucket } : {});
    return page.items.map((item) => item.id);
  }

  async function waitForQueuesDrained(): Promise<void> {
    const queues = [DOMAIN_EVENTS_QUEUE, CHANNEL_DISPATCH_QUEUE].map((name) =>
      ctx.app.get<Queue>(getQueueToken(name)),
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

  describe('money_request_created notification', () => {
    async function notifyPayer(followed: boolean) {
      const requester = await seedUser('nreq');
      const payer = await seedUser('npay');
      const payerUser = await ctx.usersService.findById(payer.userId);
      const pushToken = `push-soft-${payer.userId}`;
      await ctx.notificationService.registerPushToken(
        payer.userId,
        'android',
        pushToken,
      );
      if (followed) {
        await follow(payer.userId, requester.userId);
      }

      const created = await createRequest(requester.userId, payer.userId);
      await waitFor(
        async () =>
          (await ctx.notificationRepo.countBy({
            userId: payer.userId,
            type: 'money_request_created',
          })) > 0,
      );
      await waitForQueuesDrained();

      return {
        created,
        inApp: await ctx.notificationRepo.findBy({
          userId: payer.userId,
          type: 'money_request_created',
        }),
        emails: ctx.emailAdapter.sent.filter(
          (message) =>
            message.to === payerUser.email &&
            message.subject.includes('requested'),
        ),
        pushes: ctx.pushAdapter.sent.filter(
          (message) => message.token === pushToken,
        ),
      };
    }

    it('uses email, push and in-app when the payer follows the requester', async () => {
      const { created, inApp, emails, pushes } = await notifyPayer(true);

      expect(inApp.map((row) => row.dedupeKey)).toEqual([created.id]);
      expect(emails).toHaveLength(1);
      expect(pushes).toHaveLength(1);
    });

    it('is in-app only when the payer does not follow the requester', async () => {
      const { created, inApp, emails, pushes } = await notifyPayer(false);

      expect(inApp.map((row) => row.dedupeKey)).toEqual([created.id]);
      expect(emails).toHaveLength(0);
      expect(pushes).toHaveLength(0);
    });
  });

  describe('GET /money-requests/incoming?bucket=', () => {
    it('splits requests by whether the payer follows the requester, and returns both when omitted', async () => {
      const payer = await seedUser('bpay');
      const friend = await seedUser('bfriend');
      const stranger = await seedUser('bstranger');
      await follow(payer.userId, friend.userId);

      const fromFriend = await createRequest(friend.userId, payer.userId);
      const fromStranger = await createRequest(stranger.userId, payer.userId);

      expect(await incomingIds(payer.userId, 'following')).toEqual([
        fromFriend.id,
      ]);
      expect(await incomingIds(payer.userId, 'others')).toEqual([
        fromStranger.id,
      ]);
      expect(await incomingIds(payer.userId)).toEqual([
        fromStranger.id,
        fromFriend.id,
      ]);
    });

    it('returns nothing in following and everything in others for a payer who follows no one', async () => {
      const payer = await seedUser('npay');
      const requester = await seedUser('nreq');
      const created = await createRequest(requester.userId, payer.userId);

      expect(await incomingIds(payer.userId, 'following')).toEqual([]);
      expect(await incomingIds(payer.userId, 'others')).toEqual([created.id]);
    });

    it('rejects an unknown bucket with 400', async () => {
      const payer = await seedUser('ipay');
      await http()
        .get('/money-requests/incoming')
        .query({ bucket: 'friends' })
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(400);
    });

    it('re-buckets live as the payer follows and unfollows the requester', async () => {
      const payer = await seedUser('lpay');
      const requester = await seedUser('lreq');
      const created = await createRequest(requester.userId, payer.userId);
      expect(await incomingIds(payer.userId, 'others')).toEqual([created.id]);

      await follow(payer.userId, requester.userId);
      expect(await incomingIds(payer.userId, 'following')).toEqual([
        created.id,
      ]);
      expect(await incomingIds(payer.userId, 'others')).toEqual([]);

      await unfollow(payer.userId, requester.userId);
      expect(await incomingIds(payer.userId, 'following')).toEqual([]);
      expect(await incomingIds(payer.userId, 'others')).toEqual([created.id]);
    });

    it('still hides pending requests from blocked users within a bucket', async () => {
      const payer = await seedUser('xpay');
      const blocked = await seedUser('xblocked');
      const friend = await seedUser('xfriend');
      await follow(payer.userId, blocked.userId);
      await follow(payer.userId, friend.userId);

      const pending = await createRequest(blocked.userId, payer.userId);
      const declined = await createRequest(blocked.userId, payer.userId);
      await http()
        .post(`/money-requests/${declined.id}/decline`)
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(201);
      const fromFriend = await createRequest(friend.userId, payer.userId);
      expect(await incomingIds(payer.userId, 'following')).toEqual([
        fromFriend.id,
        declined.id,
        pending.id,
      ]);

      await block(payer.userId, blocked.userId);

      expect(await incomingIds(payer.userId, 'following')).toEqual([
        fromFriend.id,
      ]);
      expect(await incomingIds(payer.userId, 'others')).toEqual([declined.id]);
      expect(await incomingIds(payer.userId)).toEqual([
        fromFriend.id,
        declined.id,
      ]);
    });

    it('paginates within a bucket without leaking the other bucket', async () => {
      const payer = await seedUser('ppay');
      const friendA = await seedUser('pfrienda');
      const friendB = await seedUser('pfriendb');
      const stranger = await seedUser('pstranger');
      await follow(payer.userId, friendA.userId);
      await follow(payer.userId, friendB.userId);

      const following: string[] = [];
      const others: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        following.push((await createRequest(friendA.userId, payer.userId)).id);
        others.push((await createRequest(stranger.userId, payer.userId)).id);
        following.push((await createRequest(friendB.userId, payer.userId)).id);
      }

      async function walk(bucket: 'following' | 'others'): Promise<string[]> {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: MoneyRequestListBody = await listIncoming(payer.userId, {
            bucket,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          expect(page.items.length).toBeLessThanOrEqual(1);
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor);
        return seen;
      }

      expect(await walk('following')).toEqual([...following].reverse());
      expect(await walk('others')).toEqual([...others].reverse());
    });
  });
});
