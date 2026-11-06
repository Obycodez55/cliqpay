import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { PostReaction } from '../../src/modules/social/entities/post-reaction.entity';
import { KycTier } from '../../src/modules/users/users.service';
import {
  DOMAIN_EVENTS_QUEUE,
  EventBusService,
} from '../../src/shared/events/event-bus.service';
import {
  POST_REACTION_EVENT,
  PostReactionEventPayload,
} from '../../src/shared/events/domain-events';
import { CHANNEL_DISPATCH_QUEUE } from '../../src/modules/notifications/internal/channel-dispatch.queue';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const ZERO_COUNTS = {
  heart: 0,
  laugh: 0,
  wow: 0,
  fire: 0,
  clap: 0,
  pray: 0,
};

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

interface FeedPost {
  transactionId: string;
  reactionCounts: Record<string, number>;
  myReaction: string | null;
}

interface FeedPage {
  items: FeedPost[];
  nextCursor: string | null;
}

describe('Social reactions', () => {
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

  async function seedUser(prefix: string, kycTier: KycTier = 'tier1') {
    idSeq += 1;
    const n = idSeq;
    const { userId } = await seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348067${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_react_${n}`,
      kycTier,
    });
    return userId;
  }

  async function follow(followerId: string, ...followeeIds: string[]) {
    await ctx.dataSource.getRepository(Follow).insert(
      followeeIds.map((followeeUserId) => ({
        followerUserId: followerId,
        followeeUserId,
      })),
    );
  }

  async function insertPost(options: {
    sender: string;
    recipient: string;
    visibility?: 'public' | 'private';
  }): Promise<string> {
    const transactionId = randomUUID();
    const visibility = options.visibility ?? 'public';
    await ctx.dataSource.query(
      `INSERT INTO transaction_posts
        (transaction_id, sender_user_id, recipient_user_id, note, visibility,
         requested_visibility, hidden_by_recipient)
       VALUES ($1, $2, $3, 'lunch', $4, $4, false)`,
      [transactionId, options.sender, options.recipient, visibility],
    );
    return transactionId;
  }

  async function postIdOf(transactionId: string): Promise<string> {
    const [row]: { id: string }[] = await ctx.dataSource.query(
      'SELECT id FROM transaction_posts WHERE transaction_id = $1',
      [transactionId],
    );
    return row.id;
  }

  async function seedPublicPost() {
    const sender = await seedUser('sender');
    const recipient = await seedUser('recipient');
    const transactionId = await insertPost({ sender, recipient });
    return { sender, recipient, transactionId };
  }

  function http() {
    return request(ctx.app.getHttpServer());
  }

  function react(userId: string, transactionId: string, reaction: string) {
    return http()
      .put(`/social/posts/${transactionId}/reaction`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ reaction });
  }

  function unreact(userId: string, transactionId: string) {
    return http()
      .delete(`/social/posts/${transactionId}/reaction`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  function getPost(viewerId: string, transactionId: string) {
    return http()
      .get(`/social/posts/${transactionId}`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  async function postView(
    viewerId: string,
    transactionId: string,
  ): Promise<FeedPost> {
    return dataOf<FeedPost>(await getPost(viewerId, transactionId).expect(200));
  }

  async function feed(viewerId: string): Promise<FeedPost[]> {
    const res = await http()
      .get('/social/feed')
      .query({ limit: 50 })
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`)
      .expect(200);
    return dataOf<FeedPage>(res).items;
  }

  function setVisibility(
    senderId: string,
    transactionId: string,
    visibility: 'public' | 'private',
  ) {
    return http()
      .patch(`/social/posts/${transactionId}/visibility`)
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({ visibility })
      .expect(200);
  }

  function block(blockerId: string, blockedId: string) {
    return http()
      .put(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`)
      .expect(200);
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

  function reactionNotifications(userId: string) {
    return ctx.notificationRepo.findBy({ userId, type: 'post_reaction' });
  }

  describe('post_reactions table', () => {
    it('rejects a reaction outside the fixed set', async () => {
      const { sender, transactionId } = await seedPublicPost();
      const postId = await postIdOf(transactionId);

      await expect(
        ctx.dataSource.query(
          `INSERT INTO post_reactions (post_id, user_id, reaction) VALUES ($1, $2, 'thumbs_up')`,
          [postId, sender],
        ),
      ).rejects.toThrow(/CHK_post_reactions_reaction/);
    });

    it('rejects a reaction on a post that does not exist', async () => {
      const user = await seedUser('fk');

      await expect(
        ctx.dataSource.query(
          `INSERT INTO post_reactions (post_id, user_id, reaction) VALUES ($1, $2, 'heart')`,
          [randomUUID(), user],
        ),
      ).rejects.toThrow(/FK_post_reactions_post_id/);
    });

    it('holds at most one reaction per user per post', async () => {
      const { sender, transactionId } = await seedPublicPost();
      const postId = await postIdOf(transactionId);
      const repo = ctx.dataSource.getRepository(PostReaction);
      await repo.insert({ postId, userId: sender, reaction: 'heart' });

      await expect(
        repo.insert({ postId, userId: sender, reaction: 'fire' }),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  describe('PUT and DELETE /social/posts/:transactionId/reaction', () => {
    it('sets, replaces and removes the caller’s reaction, and DELETE is idempotent', async () => {
      const { sender, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);

      const set = await react(viewer, transactionId, 'heart').expect(200);
      expect(dataOf(set)).toEqual({ transactionId, reaction: 'heart' });
      expect(await postView(viewer, transactionId)).toMatchObject({
        reactionCounts: { ...ZERO_COUNTS, heart: 1 },
        myReaction: 'heart',
      });

      await react(viewer, transactionId, 'fire').expect(200);
      expect(await postView(viewer, transactionId)).toMatchObject({
        reactionCounts: { ...ZERO_COUNTS, fire: 1 },
        myReaction: 'fire',
      });

      for (let i = 0; i < 2; i++) {
        const removed = await unreact(viewer, transactionId).expect(200);
        expect(dataOf(removed)).toEqual({ transactionId, reaction: null });
      }
      expect(await postView(viewer, transactionId)).toMatchObject({
        reactionCounts: ZERO_COUNTS,
        myReaction: null,
      });
    });

    it('lets either participant react to their own post', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();

      await react(sender, transactionId, 'clap').expect(200);
      await react(recipient, transactionId, 'pray').expect(200);

      expect(await postView(recipient, transactionId)).toMatchObject({
        reactionCounts: { ...ZERO_COUNTS, clap: 1, pray: 1 },
        myReaction: 'pray',
      });
    });

    it('rejects a reaction outside the fixed set with a validation error', async () => {
      const { sender, transactionId } = await seedPublicPost();

      const res = await react(sender, transactionId, 'thumbs_up').expect(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    describe('returns 404 POST_NOT_FOUND when the caller cannot read the post', () => {
      async function expectNotFound(userId: string, transactionId: string) {
        const put = await react(userId, transactionId, 'heart').expect(404);
        expect(errorOf(put).code).toBe('POST_NOT_FOUND');
        const del = await unreact(userId, transactionId).expect(404);
        expect(errorOf(del).code).toBe('POST_NOT_FOUND');
      }

      it('for a post that does not exist', async () => {
        await expectNotFound(await seedUser('ghost'), randomUUID());
      });

      it('for a public post by people the caller does not follow', async () => {
        const { transactionId } = await seedPublicPost();
        await expectNotFound(await seedUser('stranger'), transactionId);
      });

      it('for a followed user’s private post', async () => {
        const sender = await seedUser('sender');
        const recipient = await seedUser('recipient');
        const viewer = await seedUser('viewer');
        await follow(viewer, sender);
        const transactionId = await insertPost({
          sender,
          recipient,
          visibility: 'private',
        });
        await expectNotFound(viewer, transactionId);
      });

      it.each([
        { name: 'the viewer blocked a participant', viewerBlocks: true },
        { name: 'a participant blocked the viewer', viewerBlocks: false },
      ])('across a block when $name', async ({ viewerBlocks }) => {
        const { sender, transactionId } = await seedPublicPost();
        const viewer = await seedUser('viewer');
        await follow(viewer, sender);
        if (viewerBlocks) {
          await block(viewer, sender);
        } else {
          await block(sender, viewer);
          // A block removes follows; restore it so only the block stands
          // between the viewer and the post.
          await follow(viewer, sender);
        }

        await expectNotFound(viewer, transactionId);
      });
    });

    const participantBlocks = [
      { name: 'they blocked the counterparty', participantBlocks: true },
      { name: 'the counterparty blocked them', participantBlocks: false },
    ];

    it.each(participantBlocks)(
      'rejects a participant reacting across a block when $name',
      async ({ participantBlocks }) => {
        const { sender, recipient, transactionId } = await seedPublicPost();
        if (participantBlocks) {
          await block(sender, recipient);
        } else {
          await block(recipient, sender);
        }

        const res = await react(sender, transactionId, 'heart').expect(422);

        expect(errorOf(res).code).toBe('INTERACTION_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/block/i);
        expect(
          await ctx.dataSource
            .getRepository(PostReaction)
            .countBy({ userId: sender }),
        ).toBe(0);
        expect(
          (await postView(recipient, transactionId)).reactionCounts,
        ).toEqual(ZERO_COUNTS);
      },
    );

    it('sees a block committed while a participant’s reaction waits on the pair lock', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const [low, high] = [sender, recipient].sort();
      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `social-pair:${low}:${high}`,
        ]);
        await runner.query(
          'INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)',
          [recipient, sender],
        );

        const pending = react(sender, transactionId, 'heart').then(
          (res) => res,
        );
        await waitFor(async () => {
          const waiting: unknown[] = await ctx.dataSource.query(
            `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          return waiting.length > 0;
        });
        await runner.commitTransaction();

        const res = await pending;
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('INTERACTION_UNAVAILABLE');
      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }
        await runner.release();
      }
      expect(
        await ctx.dataSource
          .getRepository(PostReaction)
          .countBy({ userId: sender }),
      ).toBe(0);
    });

    it.each([
      { name: 'the reactor blocked a participant', reactorBlocks: true },
      { name: 'a participant blocked the reactor', reactorBlocks: false },
    ])(
      'lets a reactor withdraw their reaction after losing sight of the post when $name',
      async ({ reactorBlocks }) => {
        const { sender, recipient, transactionId } = await seedPublicPost();
        const viewer = await seedUser('viewer');
        await follow(viewer, sender);
        await react(viewer, transactionId, 'heart').expect(200);
        if (reactorBlocks) {
          await block(viewer, sender);
        } else {
          await block(sender, viewer);
        }
        await getPost(viewer, transactionId).expect(404);

        const res = await unreact(viewer, transactionId).expect(200);

        expect(dataOf(res)).toEqual({ transactionId, reaction: null });
        expect(
          await ctx.dataSource
            .getRepository(PostReaction)
            .countBy({ userId: viewer }),
        ).toBe(0);
        expect(
          (await postView(recipient, transactionId)).reactionCounts,
        ).toEqual(ZERO_COUNTS);
        await unreact(viewer, transactionId).expect(404);
      },
    );

    it('rejects Tier 0 callers with KYC_VERIFICATION_REQUIRED', async () => {
      const sender = await seedUser('sender', 'tier0');
      const recipient = await seedUser('recipient');
      const transactionId = await insertPost({ sender, recipient });

      const put = await react(sender, transactionId, 'heart').expect(422);
      expect(errorOf(put).code).toBe('KYC_VERIFICATION_REQUIRED');
      const del = await unreact(sender, transactionId).expect(422);
      expect(errorOf(del).code).toBe('KYC_VERIFICATION_REQUIRED');
    });
  });

  describe('counts in the feed and post view', () => {
    it('reports every reaction key, zero when unused, and null for no own reaction', async () => {
      const { sender, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);

      const [item] = await feed(viewer);
      expect(item).toMatchObject({
        transactionId,
        reactionCounts: ZERO_COUNTS,
        myReaction: null,
      });
      expect(await postView(viewer, transactionId)).toMatchObject({
        reactionCounts: ZERO_COUNTS,
        myReaction: null,
      });
    });

    it('aggregates per post across a page, with each viewer’s own reaction', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const first = await insertPost({ sender, recipient });
      const second = await insertPost({ sender, recipient });
      const viewers = [
        await seedUser('va'),
        await seedUser('vb'),
        await seedUser('vc'),
      ];
      for (const viewer of viewers) {
        await follow(viewer, sender);
      }
      await react(viewers[0], first, 'heart').expect(200);
      await react(viewers[1], first, 'heart').expect(200);
      await react(viewers[2], first, 'laugh').expect(200);
      await react(viewers[0], second, 'fire').expect(200);

      const byId = new Map(
        (await feed(viewers[0])).map((item) => [item.transactionId, item]),
      );
      expect(byId.get(first)).toMatchObject({
        reactionCounts: { ...ZERO_COUNTS, heart: 2, laugh: 1 },
        myReaction: 'heart',
      });
      expect(byId.get(second)).toMatchObject({
        reactionCounts: { ...ZERO_COUNTS, fire: 1 },
        myReaction: 'fire',
      });

      const third = new Map(
        (await feed(viewers[2])).map((item) => [item.transactionId, item]),
      );
      expect(third.get(first)?.myReaction).toBe('laugh');
      expect(third.get(second)?.myReaction).toBeNull();
    });
  });

  describe('after a participant blocks a reactor', () => {
    it('leaves the reactor’s reactions out of the counts for every reader', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const reactor = await seedUser('reactor');
      const bystander = await seedUser('bystander');
      await follow(reactor, sender);
      await follow(bystander, sender);
      await react(reactor, transactionId, 'heart').expect(200);
      await react(bystander, transactionId, 'fire').expect(200);

      await block(sender, reactor);

      const expected = { ...ZERO_COUNTS, fire: 1 };
      for (const viewer of [sender, recipient, bystander]) {
        expect((await postView(viewer, transactionId)).reactionCounts).toEqual(
          expected,
        );
      }
      const [item] = await feed(bystander);
      expect(item.reactionCounts).toEqual(expected);
    });
  });

  describe('when a post goes private', () => {
    it('keeps its reactions for the participants only, and restores them when it goes public again', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);
      await react(viewer, transactionId, 'heart').expect(200);
      await react(recipient, transactionId, 'fire').expect(200);
      const expected = { ...ZERO_COUNTS, heart: 1, fire: 1 };

      await setVisibility(sender, transactionId, 'private');

      expect(
        errorOf(await getPost(viewer, transactionId).expect(404)).code,
      ).toBe('POST_NOT_FOUND');
      expect(await feed(viewer)).toEqual([]);
      await react(viewer, transactionId, 'wow').expect(404);
      for (const participant of [sender, recipient]) {
        expect(await postView(participant, transactionId)).toMatchObject({
          reactionCounts: expected,
        });
      }
      expect((await postView(recipient, transactionId)).myReaction).toBe(
        'fire',
      );

      await setVisibility(sender, transactionId, 'public');

      expect(await postView(viewer, transactionId)).toMatchObject({
        reactionCounts: expected,
        myReaction: 'heart',
      });
    });
  });

  describe('post_reaction notification', () => {
    it('notifies both participants in-app when someone else reacts, never by push or email, and not the reactor', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);
      const token = `push-react-${sender}`;
      await ctx.notificationService.registerPushToken(sender, 'ios', token);
      const emailsBefore = ctx.emailAdapter.sent.length;

      await react(viewer, transactionId, 'heart').expect(200);
      await waitForQueuesDrained();

      for (const participant of [sender, recipient]) {
        const rows = await reactionNotifications(participant);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: 'New reaction',
          data: { transactionId, reactorUserId: viewer },
          dedupeKey: `${transactionId}:${viewer}`,
        });
        expect(rows[0].body).toContain('viewer_react_');
      }
      expect(await reactionNotifications(viewer)).toHaveLength(0);
      expect(
        ctx.pushAdapter.sent.filter((message) => message.token === token),
      ).toHaveLength(0);
      expect(ctx.emailAdapter.sent.length).toBe(emailsBefore);
    });

    it('notifies only the other participant when a participant reacts', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();

      await react(recipient, transactionId, 'clap').expect(200);
      await waitForQueuesDrained();

      expect(await reactionNotifications(sender)).toHaveLength(1);
      expect(await reactionNotifications(recipient)).toHaveLength(0);
    });

    it('does not notify when a reaction is replaced or removed', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);
      await react(viewer, transactionId, 'heart').expect(200);
      await waitForQueuesDrained();
      // Clearing the rows means the in-app dedupe can't mask a second publish.
      await ctx.notificationRepo.delete({
        type: 'post_reaction',
        userId: sender,
      });
      await ctx.notificationRepo.delete({
        type: 'post_reaction',
        userId: recipient,
      });

      await react(viewer, transactionId, 'fire').expect(200);
      await unreact(viewer, transactionId).expect(200);
      await waitForQueuesDrained();

      expect(await reactionNotifications(sender)).toHaveLength(0);
      expect(await reactionNotifications(recipient)).toHaveLength(0);
    });

    it('does not stack in-app rows when a reaction is removed and added again', async () => {
      const { sender, transactionId } = await seedPublicPost();
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);

      await react(viewer, transactionId, 'heart').expect(200);
      await waitForQueuesDrained();
      await unreact(viewer, transactionId).expect(200);
      await react(viewer, transactionId, 'laugh').expect(200);
      await waitForQueuesDrained();

      expect(await reactionNotifications(sender)).toHaveLength(1);
    });

    describe('at dispatch time', () => {
      async function publishPostReaction(
        userId: string,
        reactorUserId: string,
      ): Promise<void> {
        await ctx.app
          .get(EventBusService)
          .publish<string, PostReactionEventPayload>({
            name: POST_REACTION_EVENT,
            payload: {
              userId,
              transactionId: randomUUID(),
              reactorUserId,
              reactorUsername: 'someone',
            },
            occurredAt: new Date(),
          });
      }

      it.each([
        { name: 'the recipient blocked the reactor', recipientBlocks: true },
        { name: 'the reactor blocked the recipient', recipientBlocks: false },
      ])('is skipped when $name', async ({ recipientBlocks }) => {
        const userId = await seedUser('nra');
        const reactor = await seedUser('nrb');
        if (recipientBlocks) {
          await block(userId, reactor);
        } else {
          await block(reactor, userId);
        }

        await publishPostReaction(userId, reactor);
        await waitForQueuesDrained();

        expect(await reactionNotifications(userId)).toHaveLength(0);
      });

      it('is delivered when there is no block', async () => {
        const userId = await seedUser('nda');
        const reactor = await seedUser('ndb');

        await publishPostReaction(userId, reactor);
        await waitForQueuesDrained();

        expect(await reactionNotifications(userId)).toHaveLength(1);
      });
    });
  });
});
