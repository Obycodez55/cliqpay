import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { BillSplitModule } from '../../src/modules/billsplit/billsplit.module';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  SplitBody,
  SplitUser,
  createBillSplitHelpers,
} from './support/billsplit-test-context';
import {
  createSocialBlocksTestHelpers,
  waitFor,
} from './support/social-blocks-test-helpers';
import { dataOf, errorOf } from './support/api-response';
import { BILL_SPLIT_EVENTS_QUEUE } from '../../src/modules/billsplit/internal/bill-split-events.queue';
import { CHANNEL_DISPATCH_QUEUE } from '../../src/modules/notifications/internal/channel-dispatch.queue';
import { Follow } from '../../src/modules/social/entities/follow.entity';

jest.setTimeout(180_000);

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

interface PostRow {
  kind: string;
  author_user_id: string;
  visibility: string;
  requested_visibility: string;
  note: string | null;
  published_at: Date | null;
  is_public: boolean;
}

interface PostBody {
  transactionId: string;
  kind: string;
  participants: { userId: string; role: string }[];
  commentCount: number;
  reactionCounts: Record<string, number>;
  visibility?: string;
  isPublic?: boolean;
  published?: boolean;
  hidden?: boolean;
}

describe('bill split posts', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);
  const s = createSocialBlocksTestHelpers(() => ctx);

  beforeAll(async () => {
    // In-memory throttler storage for the per-user comment limit, without
    // the global IP-keyed guard that would cap this whole spec's traffic.
    ctx = await createTransfersTestContext(0, [
      BillSplitModule,
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ]);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSplit(
    options: { visibility?: 'public' | 'private'; members?: number } = {},
  ) {
    const initiator = await h.seedUser('initiator');
    await ctx.notificationService.registerPushToken(
      initiator.userId,
      'android',
      `push-token-post-${initiator.userId}`,
    );
    const members: SplitUser[] = [];
    for (let i = 0; i < (options.members ?? 3); i++) {
      members.push(await h.seedUser('member', { balanceMinor: 50_000_000n }));
    }
    const split = dataOf<SplitBody>(
      await h
        .createSplit(initiator.userId, {
          visibility: options.visibility ?? 'public',
          total: 30_000 * members.length,
          participants: members.map((m) => ({ userId: m.userId })),
        })
        .expect(201),
    );
    const requestOf = (user: SplitUser) =>
      split.participants.find((p) => p.userId === user.userId)!.moneyRequestId;
    return { initiator, members, split, requestOf };
  }

  async function postRow(id: string): Promise<PostRow> {
    const [row] = await ctx.dataSource.query<PostRow[]>(
      `SELECT kind, author_user_id, visibility, requested_visibility, note, published_at, is_public FROM posts WHERE id = $1`,
      [id],
    );
    return row;
  }

  const as = (userId: string) => ({
    Authorization: `Bearer ${s.tokenFor(userId)}`,
  });

  const getPost = (viewerId: string, id: string) =>
    s.http().get(`/social/posts/${id}`).set(as(viewerId));
  const react = (userId: string, id: string) =>
    s
      .http()
      .put(`/social/posts/${id}/reaction`)
      .set(as(userId))
      .send({ reaction: 'heart' });
  const comment = (userId: string, id: string, body = 'nice') =>
    s
      .http()
      .post(`/social/posts/${id}/comments`)
      .set(as(userId))
      .send({ body });
  const listComments = (userId: string, id: string) =>
    s.http().get(`/social/posts/${id}/comments`).set(as(userId));
  const hide = (userId: string, id: string) =>
    s.http().put(`/social/posts/${id}/hide`).set(as(userId));
  const feed = (userId: string) => s.http().get('/social/feed').set(as(userId));

  async function payAll(
    members: SplitUser[],
    requestOf: (u: SplitUser) => string,
  ) {
    for (const m of members) {
      await h.payRequest(m.userId, requestOf(m)).expect(201);
    }
  }

  const notificationsOf = (userId: string, type: string) =>
    ctx.notificationRepo.findBy({ userId, type: type as never });

  describe('creation', () => {
    it('requires a visibility with no default', async () => {
      const initiator = await h.seedUser('initiator');
      const member = await h.seedUser('member');
      const res = await h
        .createSplit(initiator.userId, {
          visibility: undefined,
          participants: [{ userId: member.userId }],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/visibility/);

      await h
        .createSplit(initiator.userId, {
          visibility: 'friends',
          participants: [{ userId: member.userId }],
        })
        .expect(400);
    });

    it('creates one unpublished, non-public post per split in the creation transaction', async () => {
      const { initiator, members, split } = await seedSplit({
        visibility: 'public',
      });

      const post = await postRow(split.id);
      expect(post).toMatchObject({
        kind: 'bill_split',
        author_user_id: initiator.userId,
        visibility: 'public',
        requested_visibility: 'public',
        note: 'Dinner',
        published_at: null,
        is_public: false,
      });
      const participants = await ctx.dataSource.query<
        { user_id: string; role: string; post_is_public: boolean }[]
      >(
        `SELECT user_id, role, post_is_public FROM post_participants WHERE post_id = $1`,
        [split.id],
      );
      expect(participants).toHaveLength(members.length + 1);
      expect(
        participants.find((p) => p.user_id === initiator.userId)?.role,
      ).toBe('author');
      expect(
        participants.filter((p) => p.role === 'member').map((p) => p.user_id),
      ).toEqual(expect.arrayContaining(members.map((m) => m.userId)));
      expect(participants.every((p) => !p.post_is_public)).toBe(true);
    });

    it('writes no post when the split fails', async () => {
      const initiator = await h.seedUser('initiator');
      const member = await h.seedUser('member');
      await s.block(member.userId, initiator.userId).expect(200);
      await h
        .createSplit(initiator.userId, {
          participants: [{ userId: member.userId }],
        })
        .expect(422);
      const [{ count }] = await ctx.dataSource.query<{ count: string }[]>(
        `SELECT count(*) FROM posts WHERE author_user_id = $1`,
        [initiator.userId],
      );
      expect(count).toBe('0');
    });

    it('includes visibility in the creation fingerprint', async () => {
      const initiator = await h.seedUser('initiator');
      const member = await h.seedUser('member');
      const body = {
        reference: `vis-${randomUUID()}`,
        participants: [{ userId: member.userId }],
      };
      const first = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, { ...body, visibility: 'public' })
          .expect(201),
      );
      const replay = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, { ...body, visibility: 'public' })
          .expect(201),
      );
      expect(replay.id).toBe(first.id);

      const conflict = await h
        .createSplit(initiator.userId, { ...body, visibility: 'private' })
        .expect(409);
      expect(errorOf(conflict).code).toBe('BILL_SPLIT_REFERENCE_REUSED');
    });

    it('shows the split visibility to participants and the initiator', async () => {
      const { initiator, members, split } = await seedSplit({
        visibility: 'private',
      });
      expect(split.visibility).toBe('private');
      for (const viewer of [initiator, members[0]]) {
        const seen = dataOf<SplitBody>(
          await h.getSplit(viewer.userId, split.id).expect(200),
        );
        expect(seen.visibility).toBe('private');
      }
    });
  });

  describe('while unpublished', () => {
    it('lets participants read, react to and comment on the post, and no one else', async () => {
      const { initiator, members, split } = await seedSplit();
      const stranger = await s.seedUser('stranger');
      await ctx.dataSource.getRepository(Follow).insert({
        followerUserId: stranger.userId,
        followeeUserId: initiator.userId,
      });

      for (const viewer of [initiator, ...members]) {
        const post = dataOf<PostBody>(
          await getPost(viewer.userId, split.id).expect(200),
        );
        expect(post).toMatchObject({
          kind: 'bill_split',
          published: false,
          isPublic: false,
          visibility: 'public',
          hidden: false,
        });
      }
      await react(members[0].userId, split.id).expect(200);
      await comment(members[1].userId, split.id).expect(201);
      await comment(initiator.userId, split.id).expect(201);

      const seen = dataOf<PostBody>(
        await getPost(members[2].userId, split.id).expect(200),
      );
      expect(seen.commentCount).toBe(2);
      expect(seen.reactionCounts.heart).toBe(1);

      await getPost(stranger.userId, split.id).expect(404);
      await comment(stranger.userId, split.id).expect(404);
      await react(stranger.userId, split.id).expect(404);
    });

    it('lets every member hide the post before publication, telling no one who did', async () => {
      const { initiator, members, split } = await seedSplit();

      const hidden = await hide(members[0].userId, split.id).expect(200);
      expect(dataOf<{ hidden: boolean }>(hidden).hidden).toBe(true);

      for (const viewer of [initiator, members[1], members[2]]) {
        const post = dataOf<PostBody>(
          await getPost(viewer.userId, split.id).expect(200),
        );
        expect(post.hidden).toBe(false);
      }
      expect(
        dataOf<PostBody>(await getPost(members[0].userId, split.id).expect(200))
          .hidden,
      ).toBe(true);

      await hide(members[2].userId, split.id).expect(200);
    });
  });

  describe('notifications', () => {
    it('notifies the author of a comment by push and in-app, and of a reaction in-app only', async () => {
      const { initiator, members, split } = await seedSplit();
      const token = `push-token-post-${initiator.userId}`;

      await comment(members[0].userId, split.id).expect(201);
      await react(members[1].userId, split.id).expect(200);
      await s.waitForQueuesDrained();

      await waitFor(
        async () =>
          (await notificationsOf(initiator.userId, 'post_comment')).length ===
            1 &&
          (await notificationsOf(initiator.userId, 'post_reaction')).length ===
            1,
      );
      const pushes = ctx.pushAdapter.sent.filter((m) => m.token === token);
      expect(pushes.filter((m) => m.title === 'New comment')).toHaveLength(1);
      expect(pushes.filter((m) => m.title === 'New reaction')).toHaveLength(0);

      for (const member of members) {
        expect(
          await notificationsOf(member.userId, 'post_comment'),
        ).toHaveLength(0);
        expect(
          await notificationsOf(member.userId, 'post_reaction'),
        ).toHaveLength(0);
      }
    });

    it('notifies no one when the author comments or reacts', async () => {
      const { initiator, members, split } = await seedSplit();
      await comment(initiator.userId, split.id).expect(201);
      await react(initiator.userId, split.id).expect(200);
      await s.waitForQueuesDrained();
      await settle();

      for (const user of [initiator, ...members]) {
        expect(await notificationsOf(user.userId, 'post_comment')).toHaveLength(
          0,
        );
        expect(
          await notificationsOf(user.userId, 'post_reaction'),
        ).toHaveLength(0);
      }
    });

    it('drops the notification when the author blocks the commenter before dispatch', async () => {
      const { initiator, members, split } = await seedSplit();
      const dispatch = ctx.app.get<Queue>(
        getQueueToken(CHANNEL_DISPATCH_QUEUE),
      );

      await dispatch.pause();
      try {
        await comment(members[0].userId, split.id).expect(201);
        await react(members[0].userId, split.id).expect(200);
        await settle();
        await s.block(initiator.userId, members[0].userId).expect(200);
      } finally {
        await dispatch.resume();
      }
      await s.waitForQueuesDrained();
      await settle();

      expect(
        await notificationsOf(initiator.userId, 'post_comment'),
      ).toHaveLength(0);
      expect(
        await notificationsOf(initiator.userId, 'post_reaction'),
      ).toHaveLength(0);
    });
  });

  describe('members who have blocked each other', () => {
    it('can share a split; cannot interact on its post; each hides the other’s content', async () => {
      const initiator = await h.seedUser('initiator');
      const a = await h.seedUser('blocker', { balanceMinor: 50_000_000n });
      const b = await h.seedUser('blocked', { balanceMinor: 50_000_000n });
      const c = await h.seedUser('bystander', { balanceMinor: 50_000_000n });
      await s.block(a.userId, b.userId).expect(200);
      await s.block(b.userId, a.userId).expect(200);

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            visibility: 'public',
            total: 90_000,
            participants: [a, b, c].map((m) => ({ userId: m.userId })),
          })
          .expect(201),
      );

      for (const user of [a, b]) {
        const rejectedComment = await comment(user.userId, split.id).expect(
          422,
        );
        expect(errorOf(rejectedComment).code).toBe('INTERACTION_UNAVAILABLE');
        const rejectedReaction = await react(user.userId, split.id).expect(422);
        expect(errorOf(rejectedReaction).code).toBe('INTERACTION_UNAVAILABLE');
      }
      await comment(c.userId, split.id, 'from c').expect(201);
      await comment(initiator.userId, split.id, 'from initiator').expect(201);

      await ctx.dataSource.query(
        `INSERT INTO post_comments (post_id, author_user_id, body)
        VALUES ($1, $2, 'from a'), ($1, $3, 'from b')`,
        [split.id, a.userId, b.userId],
      );
      const bodiesFor = async (viewer: string) =>
        dataOf<{ items: { body: string }[] }>(
          await listComments(viewer, split.id).expect(200),
        ).items.map((item) => item.body);

      expect(await bodiesFor(a.userId)).toEqual(['from c', 'from initiator']);
      expect(await bodiesFor(b.userId)).toEqual(['from c', 'from initiator']);
      expect(await bodiesFor(c.userId)).toEqual(['from c', 'from initiator']);
      expect(
        dataOf<PostBody>(await getPost(c.userId, split.id).expect(200))
          .commentCount,
      ).toBe(2);
    });
  });

  describe('publication', () => {
    const publishedAtOf = async (id: string) =>
      (await postRow(id)).published_at;

    it('publishes a public split post when the split completes, via the event handler', async () => {
      const { members, split, requestOf } = await seedSplit({
        visibility: 'public',
      });
      await payAll(members.slice(0, 2), requestOf);
      await settle();
      expect(await publishedAtOf(split.id)).toBeNull();

      await h.payRequest(members[2].userId, requestOf(members[2])).expect(201);
      await waitFor(async () => (await publishedAtOf(split.id)) !== null);

      expect(await postRow(split.id)).toMatchObject({ is_public: true });
      const [{ count }] = await ctx.dataSource.query<{ count: string }[]>(
        `SELECT count(*) FROM post_participants WHERE post_id = $1 AND post_is_public`,
        [split.id],
      );
      expect(Number(count)).toBe(members.length + 1);
    });

    it('publishes a private split post without making it public', async () => {
      const { members, split, requestOf } = await seedSplit({
        visibility: 'private',
      });
      await payAll(members, requestOf);
      await waitFor(async () => (await publishedAtOf(split.id)) !== null);
      expect(await postRow(split.id)).toMatchObject({ is_public: false });
    });

    it('keeps a hidden post non-public after publication', async () => {
      const { members, split, requestOf } = await seedSplit({
        visibility: 'public',
      });
      await hide(members[1].userId, split.id).expect(200);
      await payAll(members, requestOf);
      await waitFor(async () => (await publishedAtOf(split.id)) !== null);
      expect(await postRow(split.id)).toMatchObject({ is_public: false });
    });

    it('never publishes a closed split', async () => {
      const { members, split, requestOf } = await seedSplit();
      await h
        .http()
        .post(`/money-requests/${requestOf(members[0])}/decline`)
        .set(as(members[0].userId))
        .expect(201);
      await h.payRequest(members[1].userId, requestOf(members[1])).expect(201);
      await h.payRequest(members[2].userId, requestOf(members[2])).expect(201);
      await waitFor(
        async () =>
          (
            await ctx.dataSource.query<{ closed_at: Date | null }[]>(
              `SELECT closed_at FROM bill_splits WHERE id = $1`,
              [split.id],
            )
          )[0].closed_at !== null,
      );
      await settle();
      expect(await postRow(split.id)).toMatchObject({
        published_at: null,
        is_public: false,
      });
    });

    it('never publishes a cancelled split, even when a paid share lands first', async () => {
      const { initiator, members, split, requestOf } = await seedSplit();
      await h.payRequest(members[0].userId, requestOf(members[0])).expect(201);
      await h
        .http()
        .post(`/bill-splits/${split.id}/cancel`)
        .set(as(initiator.userId))
        .expect(201);
      await settle();
      await h.getSplit(initiator.userId, split.id).expect(200);
      expect(await postRow(split.id)).toMatchObject({ published_at: null });
    });

    it('never publishes an expired split', async () => {
      const { initiator, members, split, requestOf } = await seedSplit();
      await h.payRequest(members[0].userId, requestOf(members[0])).expect(201);
      await ctx.dataSource.query(
        `UPDATE bill_splits SET expires_at = now() - interval '1 day' WHERE id = $1`,
        [split.id],
      );
      const seen = dataOf<SplitBody>(
        await h.getSplit(initiator.userId, split.id).expect(200),
      );
      expect(seen.status).toBe('expired');
      await settle();
      expect(await postRow(split.id)).toMatchObject({ published_at: null });
    });

    it('publishes a lost completion event by read-repair', async () => {
      const { initiator, members, split, requestOf } = await seedSplit({
        visibility: 'public',
      });
      const queue = ctx.app.get<Queue>(getQueueToken(BILL_SPLIT_EVENTS_QUEUE));

      await queue.pause();
      try {
        await payAll(members, requestOf);
        await settle();
        expect(await publishedAtOf(split.id)).toBeNull();

        await h.getSplit(initiator.userId, split.id).expect(200);
        expect(await publishedAtOf(split.id)).not.toBeNull();
        expect(await postRow(split.id)).toMatchObject({ is_public: true });
      } finally {
        await queue.resume();
      }
    });

    it('keeps the first published_at across repeated completion events', async () => {
      const { initiator, members, split, requestOf } = await seedSplit();
      await payAll(members, requestOf);
      await waitFor(async () => (await publishedAtOf(split.id)) !== null);
      const first = await publishedAtOf(split.id);

      await h.getSplit(initiator.userId, split.id).expect(200);
      await settle();
      expect(await publishedAtOf(split.id)).toEqual(first);
    });

    it('shows a completed public split once in the feed of a viewer who follows several members', async () => {
      const { initiator, members, split, requestOf } = await seedSplit({
        visibility: 'public',
      });
      const viewer = await s.seedUser('viewer');
      await ctx.dataSource.getRepository(Follow).insert(
        [initiator, ...members].map((user) => ({
          followerUserId: viewer.userId,
          followeeUserId: user.userId,
        })),
      );
      const appearances = async () =>
        dataOf<{ items: { transactionId: string }[] }>(
          await feed(viewer.userId).expect(200),
        ).items.filter((item) => item.transactionId === split.id).length;

      await payAll(members.slice(0, 2), requestOf);
      await settle();
      expect(await appearances()).toBe(0);

      await h.payRequest(members[2].userId, requestOf(members[2])).expect(201);
      await waitFor(async () => (await publishedAtOf(split.id)) !== null);
      expect(await appearances()).toBe(1);

      const post = dataOf<PostBody>(
        await getPost(viewer.userId, split.id).expect(200),
      );
      expect(post.kind).toBe('bill_split');
      expect(post.participants).toHaveLength(members.length + 1);
    });
  });
});
