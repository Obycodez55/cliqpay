import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { Block } from '../../src/modules/social/entities/block.entity';
import { KycTier } from '../../src/modules/users/users.service';
import {
  DOMAIN_EVENTS_QUEUE,
  EventBusService,
} from '../../src/shared/events/event-bus.service';
import {
  NEW_FOLLOWER_EVENT,
  NewFollowerEventPayload,
} from '../../src/shared/events/domain-events';
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

interface Page {
  items: { userId: string }[];
  nextCursor: string | null;
}

interface MoneyRequestBody {
  id: string;
  status: string;
}

interface SeededUser {
  userId: string;
  walletId: string;
}

describe('Social blocks', () => {
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

  const followRepo = () => ctx.dataSource.getRepository(Follow);
  const blockRepo = () => ctx.dataSource.getRepository(Block);

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(
    prefix: string,
    kycTier: KycTier = 'tier1',
  ): Promise<SeededUser> {
    idSeq += 1;
    const n = idSeq;
    return seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348066${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_block_${n}`,
      kycTier,
    });
  }

  async function seedFunded(prefix: string): Promise<SeededUser> {
    const user = await seedUser(prefix, 'tier3');
    await fundWallet(ctx, {
      reference: `cliqpay-block-fund-${user.userId}`,
      walletId: user.walletId,
      netAmountMinor: 10_000_000n,
    });
    return user;
  }

  function http() {
    return request(ctx.app.getHttpServer());
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

  function listBlocks(
    userId: string,
    query: Record<string, string | number> = {},
  ) {
    return http()
      .get('/social/blocks')
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  function follow(followerId: string, followeeId: string) {
    return http()
      .put(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`);
  }

  function relationship(viewerId: string, otherId: string) {
    return http()
      .get(`/social/users/${otherId}/relationship`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  function sendMoney(senderId: string, recipientId: string) {
    return http()
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({
        recipientUserId: recipientId,
        amount: 10_000,
        reference: `cliqpay-block-xfer-${randomUUID()}`,
        pin: '1234',
        visibility: 'private',
      });
  }

  function createRequest(requesterId: string, payerId: string) {
    return http()
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
      .send({ payerUserId: payerId, amount: 10_000 });
  }

  function payRequest(payerId: string, id: string) {
    return http()
      .post(`/money-requests/${id}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .send({
        reference: `cliqpay-block-pay-${randomUUID()}`,
        pin: '1234',
        visibility: 'private',
      });
  }

  async function incomingIds(payerId: string): Promise<string[]> {
    const res = await http()
      .get('/money-requests/incoming')
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .expect(200);
    return dataOf<{ items: { id: string }[] }>(res).items.map(
      (item) => item.id,
    );
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

  function expectNoBlockedWording(res: { body: unknown }): void {
    expect(JSON.stringify(res.body)).not.toMatch(/block/i);
  }

  // Each case runs with A blocking B and again with B blocking A, so the
  // assertions hold whichever side created the block.
  const directions = [
    { name: 'the first user blocked the second', blockerIndex: 0 },
    { name: 'the second user blocked the first', blockerIndex: 1 },
  ] as const;

  async function blockBetween(
    users: [SeededUser, SeededUser],
    blockerIndex: 0 | 1,
  ): Promise<void> {
    const blocker = users[blockerIndex];
    const blocked = users[1 - blockerIndex];
    await block(blocker.userId, blocked.userId).expect(200);
  }

  describe('PUT and DELETE /social/blocks/:userId', () => {
    it('blocks and unblocks idempotently', async () => {
      const blocker = await seedUser('ba');
      const blocked = await seedUser('bb');

      const first = await block(blocker.userId, blocked.userId).expect(200);
      expect(dataOf(first)).toEqual({ userId: blocked.userId, blocked: true });
      await block(blocker.userId, blocked.userId).expect(200);
      expect(await blockRepo().countBy({ blockerUserId: blocker.userId })).toBe(
        1,
      );

      const removed = await unblock(blocker.userId, blocked.userId).expect(200);
      expect(dataOf(removed)).toEqual({
        userId: blocked.userId,
        blocked: false,
      });
      await unblock(blocker.userId, blocked.userId).expect(200);
      expect(await blockRepo().countBy({ blockerUserId: blocker.userId })).toBe(
        0,
      );
    });

    it('works at KYC Tier 0', async () => {
      const blocker = await seedUser('t0a', 'tier0');
      const blocked = await seedUser('t0b', 'tier0');

      await block(blocker.userId, blocked.userId).expect(200);
      const page = dataOf<Page>(await listBlocks(blocker.userId).expect(200));
      expect(page.items.map((item) => item.userId)).toEqual([blocked.userId]);
      await unblock(blocker.userId, blocked.userId).expect(200);
    });

    it('rejects blocking yourself with a 400', async () => {
      const user = await seedUser('bself');

      const res = await block(user.userId, user.userId).expect(400);

      expect(errorOf(res).code).toBe('SELF_BLOCK_NOT_ALLOWED');
    });

    it('rejects blocking a user that does not exist with a 404', async () => {
      const user = await seedUser('bghost');

      const res = await block(user.userId, randomUUID()).expect(404);

      expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    });

    it('enforces the database CHECK against self-blocks', async () => {
      const user = await seedUser('bcheck');

      await expect(
        blockRepo().insert({
          blockerUserId: user.userId,
          blockedUserId: user.userId,
        }),
      ).rejects.toThrow(/CHK_blocks_not_self/);
    });
  });

  describe('GET /social/blocks', () => {
    it("lists only the caller's own blocks, newest first, keyset paginated", async () => {
      const owner = await seedUser('lowner');
      const other = await seedUser('lother');
      const targets = await Promise.all([
        seedUser('lt1'),
        seedUser('lt2'),
        seedUser('lt3'),
      ]);
      for (const target of targets) {
        await block(owner.userId, target.userId).expect(200);
      }
      await block(targets[0].userId, owner.userId).expect(200);
      const stamps = ['2026-01-01', '2026-01-03', '2026-01-02'];
      for (const [i, target] of targets.entries()) {
        await blockRepo().update(
          { blockerUserId: owner.userId, blockedUserId: target.userId },
          { createdAt: new Date(`${stamps[i]}T00:00:00Z`) },
        );
      }

      const first = dataOf<Page>(
        await listBlocks(owner.userId, { limit: 2 }).expect(200),
      );
      expect(first.items.map((item) => item.userId)).toEqual([
        targets[1].userId,
        targets[2].userId,
      ]);
      const second = dataOf<Page>(
        await listBlocks(owner.userId, {
          limit: 2,
          cursor: first.nextCursor!,
        }).expect(200),
      );
      expect(second.items.map((item) => item.userId)).toEqual([
        targets[0].userId,
      ]);
      expect(second.nextCursor).toBeNull();

      const others = dataOf<Page>(await listBlocks(other.userId).expect(200));
      expect(others.items).toEqual([]);
      const blockedSide = dataOf<Page>(
        await listBlocks(targets[1].userId).expect(200),
      );
      expect(blockedSide.items).toEqual([]);
    });
  });

  describe('follows', () => {
    it('removes follows in both directions when a block is created', async () => {
      const a = await seedUser('fra');
      const b = await seedUser('frb');
      const bystander = await seedUser('frc');
      await follow(a.userId, b.userId).expect(200);
      await follow(b.userId, a.userId).expect(200);
      await follow(bystander.userId, a.userId).expect(200);

      await block(a.userId, b.userId).expect(200);

      expect(
        await followRepo().countBy({
          followerUserId: a.userId,
          followeeUserId: b.userId,
        }),
      ).toBe(0);
      expect(
        await followRepo().countBy({
          followerUserId: b.userId,
          followeeUserId: a.userId,
        }),
      ).toBe(0);
      expect(
        await followRepo().countBy({
          followerUserId: bystander.userId,
          followeeUserId: a.userId,
        }),
      ).toBe(1);
    });

    it('answers the blocked user with the same 404 as an unknown user', async () => {
      const blocker = await seedUser('fna');
      const blocked = await seedUser('fnb');
      await block(blocker.userId, blocked.userId).expect(200);

      const res = await follow(blocked.userId, blocker.userId).expect(404);
      const unknown = await follow(blocked.userId, randomUUID()).expect(404);

      expect(errorOf(res)).toEqual(errorOf(unknown));
      expectNoBlockedWording(res);
      expect(
        await followRepo().countBy({ followerUserId: blocked.userId }),
      ).toBe(0);
    });

    it('tells the blocker to unblock first', async () => {
      const blocker = await seedUser('fua');
      const blocked = await seedUser('fub');
      await block(blocker.userId, blocked.userId).expect(200);

      const res = await follow(blocker.userId, blocked.userId).expect(422);

      expect(errorOf(res).code).toBe('FOLLOW_REQUIRES_UNBLOCK');
      expect(errorOf(res).message).toMatch(/unblock/i);
      expect(
        await followRepo().countBy({ followerUserId: blocker.userId }),
      ).toBe(0);
    });

    it('allows following again in both directions after unblocking', async () => {
      const blocker = await seedUser('fga');
      const blocked = await seedUser('fgb');
      await block(blocker.userId, blocked.userId).expect(200);
      await unblock(blocker.userId, blocked.userId).expect(200);

      await follow(blocker.userId, blocked.userId).expect(200);
      await follow(blocked.userId, blocker.userId).expect(200);
    });

    async function lockWaiters(): Promise<number> {
      const [{ count }] = await ctx.dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return count;
    }

    it.each(directions)(
      'never leaves a follow standing when a block lands mid-follow and $name',
      async ({ blockerIndex }) => {
        const follower = await seedUser('racea');
        const followee = await seedUser('raceb');
        const pair: [SeededUser, SeededUser] = [follower, followee];
        // An uncommitted row on the same key parks the follow at its insert,
        // after it has already looked for a block.
        const holder = ctx.dataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        await holder.query(
          'INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)',
          [follower.userId, followee.userId],
        );

        const following = ctx.socialService.follow(
          follower.userId,
          followee.userId,
        );
        await waitFor(async () => (await lockWaiters()) === 1);

        let blockSettled = false;
        const blocking = ctx.socialService
          .block(pair[blockerIndex].userId, pair[1 - blockerIndex].userId)
          .finally(() => {
            blockSettled = true;
          });
        await waitFor(async () => blockSettled || (await lockWaiters()) === 2);

        await holder.rollbackTransaction();
        await holder.release();
        await Promise.allSettled([following, blocking]);

        expect(
          await followRepo().countBy([
            {
              followerUserId: follower.userId,
              followeeUserId: followee.userId,
            },
            {
              followerUserId: followee.userId,
              followeeUserId: follower.userId,
            },
          ]),
        ).toBe(0);
        expect(
          await blockRepo().countBy({
            blockerUserId: pair[blockerIndex].userId,
          }),
        ).toBe(1);
      },
    );
  });

  describe('relationship view', () => {
    it('shows blocked to the blocker only', async () => {
      const blocker = await seedUser('rba');
      const blocked = await seedUser('rbb');
      await follow(blocked.userId, blocker.userId).expect(200);
      await block(blocker.userId, blocked.userId).expect(200);

      const blockerView = dataOf<Record<string, unknown>>(
        await relationship(blocker.userId, blocked.userId).expect(200),
      );
      expect(blockerView).toMatchObject({
        blocked: true,
        follows: false,
        followedBy: false,
      });

      const blockedRes = await relationship(
        blocked.userId,
        blocker.userId,
      ).expect(200);
      expect(dataOf(blockedRes)).toEqual({
        userId: blocker.userId,
        follows: false,
        followedBy: false,
        blocked: false,
        followerCount: 0,
        followingCount: 0,
      });
    });

    it('shows blocked false when there is no block', async () => {
      const a = await seedUser('rna');
      const b = await seedUser('rnb');

      const view = dataOf<Record<string, unknown>>(
        await relationship(a.userId, b.userId).expect(200),
      );

      expect(view.blocked).toBe(false);
    });
  });

  describe('transfers', () => {
    it.each(directions)(
      'rejects sendMoney either way when $name',
      async ({ blockerIndex }) => {
        const users: [SeededUser, SeededUser] = [
          await seedFunded('xa'),
          await seedFunded('xb'),
        ];
        await blockBetween(users, blockerIndex);

        for (const [sender, recipient] of [users, [...users].reverse()]) {
          const res = await sendMoney(sender.userId, recipient.userId).expect(
            422,
          );
          expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
          expectNoBlockedWording(res);
        }
      },
    );

    it('posts nothing when sendMoney is rejected by a block', async () => {
      const sender = await seedFunded('xna');
      const recipient = await seedFunded('xnb');
      await block(recipient.userId, sender.userId).expect(200);
      const before = await ctx.ledgerEntryRepo.count();

      await sendMoney(sender.userId, recipient.userId).expect(422);

      expect(await ctx.ledgerEntryRepo.count()).toBe(before);
    });

    it('sends again once unblocked', async () => {
      const sender = await seedFunded('xua');
      const recipient = await seedFunded('xub');
      await block(recipient.userId, sender.userId).expect(200);
      await unblock(recipient.userId, sender.userId).expect(200);

      await sendMoney(sender.userId, recipient.userId).expect(201);
    });

    it.each(directions)(
      'rejects paying a money request when $name after it was sent',
      async ({ blockerIndex }) => {
        const requester = await seedFunded('pra');
        const payer = await seedFunded('prb');
        const created = dataOf<MoneyRequestBody>(
          await createRequest(requester.userId, payer.userId).expect(201),
        );
        await blockBetween([requester, payer], blockerIndex);

        const res = await payRequest(payer.userId, created.id).expect(422);

        expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
        expectNoBlockedWording(res);
        expect(
          (await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id }))
            .status,
        ).toBe('pending');
      },
    );
  });

  describe('money requests', () => {
    it.each(directions)(
      'rejects creating a request either way when $name',
      async ({ blockerIndex }) => {
        const users: [SeededUser, SeededUser] = [
          await seedUser('mra', 'tier3'),
          await seedUser('mrb', 'tier3'),
        ];
        await blockBetween(users, blockerIndex);

        for (const [requester, payer] of [users, [...users].reverse()]) {
          const res = await createRequest(
            requester.userId,
            payer.userId,
          ).expect(422);
          expect(errorOf(res).code).toBe('MONEY_REQUEST_NOT_ALLOWED');
          expectNoBlockedWording(res);
        }
        expect(
          await ctx.moneyRequestRepo.countBy([
            { requesterUserId: users[0].userId },
            { requesterUserId: users[1].userId },
          ]),
        ).toBe(0);
      },
    );

    it('hides pending requests from users the payer blocked, without changing them, until unblocked', async () => {
      const payer = await seedUser('ipay', 'tier3');
      const requester = await seedUser('ireq', 'tier3');
      const other = await seedUser('ioth', 'tier3');
      const pending = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      const willExpire = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      const declined = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      await http()
        .post(`/money-requests/${declined.id}/decline`)
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(201);
      const fromOther = dataOf<MoneyRequestBody>(
        await createRequest(other.userId, payer.userId).expect(201),
      );

      await block(payer.userId, requester.userId).expect(200);

      const whileBlocked = await incomingIds(payer.userId);
      expect(whileBlocked).toEqual(
        expect.arrayContaining([declined.id, fromOther.id]),
      );
      expect(whileBlocked).not.toContain(pending.id);
      expect(whileBlocked).not.toContain(willExpire.id);
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: pending.id })).status,
      ).toBe('pending');

      await ctx.moneyRequestRepo.update(
        { id: willExpire.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
      await unblock(payer.userId, requester.userId).expect(200);

      const afterRes = await http()
        .get('/money-requests/incoming')
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(200);
      const statuses = new Map(
        dataOf<{ items: MoneyRequestBody[] }>(afterRes).items.map((item) => [
          item.id,
          item.status,
        ]),
      );
      expect(statuses.get(pending.id)).toBe('pending');
      expect(statuses.get(willExpire.id)).toBe('expired');
    });

    it('keeps showing requests to the payer when it is the requester who blocked', async () => {
      const payer = await seedUser('rpay', 'tier3');
      const requester = await seedUser('rreq', 'tier3');
      const created = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );

      await block(requester.userId, payer.userId).expect(200);

      expect(await incomingIds(payer.userId)).toContain(created.id);
    });
  });

  describe('recipient lookup', () => {
    it('is unchanged by a block in either direction', async () => {
      const blocker = await seedUser('lka');
      const blocked = await seedUser('lkb');
      const [blockerUser, blockedUser] = await Promise.all([
        ctx.usersService.findById(blocker.userId),
        ctx.usersService.findById(blocked.userId),
      ]);
      await block(blocker.userId, blocked.userId).expect(200);

      for (const target of [blockerUser, blockedUser]) {
        const found = await ctx.usersService.lookupRecipient(target.username);
        expect(found?.userId).toBe(target.id);
      }
    });
  });

  describe('new_follower notification', () => {
    async function publishNewFollower(
      followerId: string,
      followeeId: string,
    ): Promise<void> {
      await ctx.app
        .get(EventBusService)
        .publish<string, NewFollowerEventPayload>({
          name: NEW_FOLLOWER_EVENT,
          payload: {
            userId: followeeId,
            followerUserId: followerId,
            followerUsername: 'someone',
          },
          occurredAt: new Date(),
        });
    }

    it.each(directions)(
      'is skipped at dispatch time when $name',
      async ({ blockerIndex }) => {
        const follower = await seedUser('nfa');
        const followee = await seedUser('nfb');
        const token = `push-block-${followee.userId}`;
        await ctx.notificationService.registerPushToken(
          followee.userId,
          'android',
          token,
        );
        await blockBetween([follower, followee], blockerIndex);

        await publishNewFollower(follower.userId, followee.userId);
        await waitForQueuesDrained();

        expect(
          await ctx.notificationRepo.countBy({
            userId: followee.userId,
            type: 'new_follower',
          }),
        ).toBe(0);
        expect(
          ctx.pushAdapter.sent.filter((message) => message.token === token),
        ).toHaveLength(0);
      },
    );

    it('is still delivered when there is no block', async () => {
      const follower = await seedUser('nda');
      const followee = await seedUser('ndb');

      await publishNewFollower(follower.userId, followee.userId);
      await waitForQueuesDrained();

      expect(
        await ctx.notificationRepo.countBy({
          userId: followee.userId,
          type: 'new_follower',
        }),
      ).toBe(1);
    });
  });
});
