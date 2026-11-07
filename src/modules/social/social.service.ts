import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { UsersService } from '../users/users.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  NEW_FOLLOWER_EVENT,
  NewFollowerEventPayload,
  POST_COMMENT_EVENT,
  POST_REACTION_EVENT,
  PostCommentEventPayload,
  PostReactionEventPayload,
} from '../../shared/events/domain-events';
import {
  IdentitySummaryDto,
  toIdentitySummary,
} from '../../common/dto/identity-summary.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { runInTransaction } from '../../database/transaction.util';
import { PostStateResponseDto } from './dto/post-state-response.dto';
import {
  POST_VISIBILITIES,
  Post,
  PostKind,
  PostOrigin,
  PostVisibility,
} from './entities/post.entity';
import {
  ParticipantRole,
  PostParticipant,
} from './entities/post-participant.entity';
import { Follow } from './entities/follow.entity';
import { Block } from './entities/block.entity';
import { FollowStateResponseDto } from './dto/follow-state-response.dto';
import { BlockStateResponseDto } from './dto/block-state-response.dto';
import { RelationshipResponseDto } from './dto/relationship-response.dto';
import {
  FeedPostResponseDto,
  PostParticipantDto,
  PostResponseDto,
  ReactionCountsDto,
} from './dto/feed-post-response.dto';
import { ReactionStateResponseDto } from './dto/reaction-state-response.dto';
import {
  PostReaction,
  REACTIONS,
  Reaction,
} from './entities/post-reaction.entity';
import { PostComment } from './entities/post-comment.entity';
import { CommentResponseDto } from './dto/comment-response.dto';
import {
  CommentNotFoundException,
  FollowLimitReachedException,
  FollowRequiresUnblockException,
  InteractionUnavailableException,
  PostNotFoundException,
  SelfBlockException,
  SelfFollowException,
  SelfRelationshipException,
  SocialKycRequiredException,
  SocialUserNotFoundException,
} from './internal/errors';

const MAX_FOLLOWING = 5_000;
const COMMENT_PAGE_SIZE = 20;

export { POST_VISIBILITIES };
export type { PostOrigin, PostVisibility };

export interface CreatePostParams {
  kind: PostKind;
  id: string;
  authorUserId: string;
  participants: { userId: string; role: ParticipantRole }[];
  note: string | null;
  visibility: PostVisibility;
  published: boolean;
  origin?: PostOrigin;
}

export interface RecordTransferPostParams {
  transactionId: string;
  senderUserId: string;
  recipientUserId: string;
  note: string | null;
  visibility: PostVisibility;
  origin?: PostOrigin;
}

export interface SocialPagination {
  cursor?: string;
  limit: number;
}

interface EdgeList {
  entity: typeof Follow | typeof Block;
  ownerColumn: string;
  otherColumn: string;
}

const FOLLOWERS: EdgeList = {
  entity: Follow,
  ownerColumn: 'followeeUserId',
  otherColumn: 'followerUserId',
};
const FOLLOWING: EdgeList = {
  entity: Follow,
  ownerColumn: 'followerUserId',
  otherColumn: 'followeeUserId',
};
const BLOCKED: EdgeList = {
  entity: Block,
  ownerColumn: 'blockerUserId',
  otherColumn: 'blockedUserId',
};

interface PostReactions {
  reactionCounts: ReactionCountsDto;
  myReaction: Reaction | null;
}

function emptyReactions(): PostReactions {
  return {
    reactionCounts: Object.fromEntries(
      REACTIONS.map((reaction) => [reaction, 0]),
    ) as Record<Reaction, number>,
    myReaction: null,
  };
}

interface CommentRow {
  id: string;
  author_user_id: string;
  body: string;
  created_at: Date;
  raw_created_at: string;
}

const PARTICIPANT_IDS = `SELECT pp.user_id FROM post_participants pp WHERE pp.post_id = p.id`;

// A participant's block hides the blocked user's comments and reactions on
// that post from everyone, so the blocker isn't left with harassment they
// can't see on their own post.
function notBlockedBy(actorColumn: string, viewerParam?: string): string {
  const viewerBlock = viewerParam
    ? `b.blocker_user_id = ${viewerParam} OR `
    : '';
  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocked_user_id = ${actorColumn}
      AND (${viewerBlock}b.blocker_user_id IN (${PARTICIPANT_IDS}))
  )`;
}

function commentVisibleTo(viewerParam: string): string {
  return notBlockedBy('c.author_user_id', viewerParam);
}

interface PostRow {
  id: string;
  kind: PostKind;
  author_user_id: string;
  note: string | null;
  origin: PostOrigin | null;
  created_at: Date;
  raw_created_at: string;
}

interface ReadablePostRow extends PostRow {
  visibility: PostVisibility;
  is_public: boolean;
  published_at: Date | null;
}

const POST_COLUMNS = `p.id, p.kind, p.author_user_id, p.note, p.origin, p.created_at,
  p.created_at::text AS raw_created_at`;

function noBlockWithViewer(viewerParam: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_user_id = ${viewerParam}
      AND b.blocked_user_id IN (${PARTICIPANT_IDS})
  )
  AND NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_user_id IN (${PARTICIPANT_IDS})
      AND b.blocked_user_id = ${viewerParam}
  )`;
}

function readableBy(viewerParam: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM post_participants pp
      WHERE pp.post_id = p.id AND pp.user_id = ${viewerParam}
    )
    OR (
      p.is_public
      AND EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_user_id = ${viewerParam}
          AND f.followee_user_id IN (${PARTICIPANT_IDS})
      )
      AND ${noBlockWithViewer(viewerParam)}
    )
  )`;
}

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
  ) {}

  // Takes no pair locks and runs no block checks between participants:
  // callers gate on blocks themselves before calling.
  async createPost(
    manager: EntityManager,
    params: CreatePostParams,
  ): Promise<void> {
    await manager.getRepository(Post).insert({
      id: params.id,
      kind: params.kind,
      authorUserId: params.authorUserId,
      note: params.note,
      visibility: params.visibility,
      requestedVisibility: params.visibility,
      origin: params.origin ?? null,
      publishedAt: params.published ? () => 'now()' : null,
      isPublic: false,
    });
    const members = [
      { userId: params.authorUserId, role: 'author' as const },
      ...params.participants,
    ];
    // Inherits the post's own created_at so the feed index and the post sort
    // on identical values.
    await manager.query(
      `INSERT INTO post_participants (post_id, user_id, role, hidden, post_created_at, post_is_public)
      SELECT p.id, m.user_id, m.role, false, p.created_at, false
      FROM posts p, unnest($2::uuid[], $3::text[]) AS m(user_id, role)
      WHERE p.id = $1`,
      [
        params.id,
        members.map((member) => member.userId),
        members.map((member) => member.role),
      ],
    );
    await this.refreshPublicity(manager, params.id);
  }

  async recordTransferPost(
    manager: EntityManager,
    params: RecordTransferPostParams,
  ): Promise<void> {
    await this.createPost(manager, {
      kind: 'transfer',
      id: params.transactionId,
      authorUserId: params.senderUserId,
      participants: [{ userId: params.recipientUserId, role: 'counterparty' }],
      note: params.note,
      visibility: params.visibility,
      published: true,
      origin: params.origin,
    });
  }

  async publishPost(manager: EntityManager, postId: string): Promise<void> {
    await manager.query(
      `UPDATE posts SET published_at = now() WHERE id = $1 AND published_at IS NULL`,
      [postId],
    );
    await this.refreshPublicity(manager, postId);
  }

  async getVisibilities(
    postIds: string[],
  ): Promise<
    Map<string, { visibility: PostVisibility; requested: PostVisibility }>
  > {
    const posts = await this.dataSource.getRepository(Post).find({
      where: { id: In(postIds) },
      select: { id: true, visibility: true, requestedVisibility: true },
    });
    return new Map(
      posts.map((post) => [
        post.id,
        { visibility: post.visibility, requested: post.requestedVisibility },
      ]),
    );
  }

  async getRequestedVisibility(
    transactionId: string,
  ): Promise<PostVisibility | null> {
    const post = await this.dataSource.getRepository(Post).findOne({
      where: { id: transactionId },
      select: { requestedVisibility: true },
    });
    return post?.requestedVisibility ?? null;
  }

  async setVisibility(
    authorId: string,
    postId: string,
    visibility: PostVisibility,
  ): Promise<PostStateResponseDto> {
    return runInTransaction(this.dataSource, async (manager) => {
      const [post]: { id: string }[] = await manager.query(
        `SELECT id FROM posts WHERE id = $1 AND author_user_id = $2 FOR UPDATE`,
        [postId, authorId],
      );
      if (!post) {
        throw new PostNotFoundException();
      }
      await manager.getRepository(Post).update({ id: postId }, { visibility });
      await this.refreshPublicity(manager, postId);
      return this.loadPostState(manager, postId, authorId);
    });
  }

  async setHidden(
    userId: string,
    postId: string,
    hidden: boolean,
  ): Promise<PostStateResponseDto> {
    return runInTransaction(this.dataSource, async (manager) => {
      await manager.query(`SELECT id FROM posts WHERE id = $1 FOR UPDATE`, [
        postId,
      ]);
      const result = await manager
        .getRepository(PostParticipant)
        .update({ postId, userId, role: Not('author') }, { hidden });
      if (!result.affected) {
        throw new PostNotFoundException();
      }
      await this.refreshPublicity(manager, postId);
      return this.loadPostState(manager, postId, userId);
    });
  }

  // The only code that writes is_public or post_is_public. Callers that
  // change what feeds into it lock the post row first, so participant rows are
  // never locked ahead of it.
  private async refreshPublicity(
    manager: EntityManager,
    postId: string,
  ): Promise<void> {
    // A separate statement from the read below, so the read's snapshot is
    // taken after any concurrent writer has committed.
    await manager.query(`SELECT id FROM posts WHERE id = $1 FOR UPDATE`, [
      postId,
    ]);
    const [row]: { is_public: boolean }[] = await manager.query(
      `SELECT p.published_at IS NOT NULL AND p.visibility = 'public' AND NOT EXISTS (
        SELECT 1 FROM post_participants pp
        WHERE pp.post_id = p.id AND pp.hidden
      ) AS is_public
      FROM posts p
      WHERE p.id = $1`,
      [postId],
    );
    await manager.query(`UPDATE posts SET is_public = $2 WHERE id = $1`, [
      postId,
      row.is_public,
    ]);
    await manager.query(
      `UPDATE post_participants SET post_is_public = $2 WHERE post_id = $1 AND post_is_public <> $2`,
      [postId, row.is_public],
    );
  }

  private async loadPostState(
    manager: EntityManager,
    postId: string,
    userId: string,
  ): Promise<PostStateResponseDto> {
    const [row]: {
      visibility: PostVisibility;
      is_public: boolean;
      hidden: boolean;
    }[] = await manager.query(
      `SELECT p.visibility, p.is_public, pp.hidden
      FROM posts p JOIN post_participants pp ON pp.post_id = p.id AND pp.user_id = $2
      WHERE p.id = $1`,
      [postId, userId],
    );
    return {
      transactionId: postId,
      visibility: row.visibility,
      isPublic: row.is_public,
      hidden: row.hidden,
    };
  }

  async follow(
    followerId: string,
    followeeId: string,
  ): Promise<FollowStateResponseDto> {
    await this.requireSocialTier(followerId);
    if (followerId === followeeId) {
      throw new SelfFollowException();
    }
    await this.requireUser(followeeId);

    const created = await runInTransaction(this.dataSource, async (manager) => {
      // Serializes a user's own follows so concurrent requests can't
      // each pass the cap check and overshoot it together.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `follows:${followerId}`,
      ]);
      await this.lockPair(manager, followerId, followeeId);
      if (await this.hasBlocked(manager, followerId, followeeId)) {
        throw new FollowRequiresUnblockException();
      }
      if (await this.hasBlocked(manager, followeeId, followerId)) {
        throw new InteractionUnavailableException();
      }
      const repo = manager.getRepository(Follow);
      if (
        await repo.existsBy({
          followerUserId: followerId,
          followeeUserId: followeeId,
        })
      ) {
        return false;
      }
      if (
        (await repo.countBy({ followerUserId: followerId })) >= MAX_FOLLOWING
      ) {
        throw new FollowLimitReachedException(MAX_FOLLOWING);
      }
      await repo.insert({
        followerUserId: followerId,
        followeeUserId: followeeId,
      });
      return true;
    });

    if (created) {
      await this.publishNewFollower(followerId, followeeId);
    }
    return { userId: followeeId, follows: true };
  }

  async unfollow(
    followerId: string,
    followeeId: string,
  ): Promise<FollowStateResponseDto> {
    await this.requireSocialTier(followerId);
    await this.dataSource.getRepository(Follow).delete({
      followerUserId: followerId,
      followeeUserId: followeeId,
    });
    return { userId: followeeId, follows: false };
  }

  async listFollowers(
    userId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    await this.requireSocialTier(userId);
    return this.listEdges(FOLLOWERS, userId, pagination);
  }

  async listFollowing(
    userId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    await this.requireSocialTier(userId);
    return this.listEdges(FOLLOWING, userId, pagination);
  }

  async block(
    blockerId: string,
    blockedId: string,
  ): Promise<BlockStateResponseDto> {
    if (blockerId === blockedId) {
      throw new SelfBlockException();
    }
    await this.requireUser(blockedId);

    await runInTransaction(this.dataSource, async (manager) => {
      await this.lockPair(manager, blockerId, blockedId);
      await manager
        .createQueryBuilder()
        .insert()
        .into(Block)
        .values({ blockerUserId: blockerId, blockedUserId: blockedId })
        .orIgnore()
        .execute();
      const follows = manager.getRepository(Follow);
      await follows.delete({
        followerUserId: blockerId,
        followeeUserId: blockedId,
      });
      await follows.delete({
        followerUserId: blockedId,
        followeeUserId: blockerId,
      });
    });
    return { userId: blockedId, blocked: true };
  }

  async unblock(
    blockerId: string,
    blockedId: string,
  ): Promise<BlockStateResponseDto> {
    await this.dataSource.getRepository(Block).delete({
      blockerUserId: blockerId,
      blockedUserId: blockedId,
    });
    return { userId: blockedId, blocked: false };
  }

  async listBlocks(
    blockerId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    return this.listEdges(BLOCKED, blockerId, pagination);
  }

  async isBlockedBetween(
    userA: string,
    userB: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<boolean> {
    return manager.getRepository(Block).exists({
      where: [
        { blockerUserId: userA, blockedUserId: userB },
        { blockerUserId: userB, blockedUserId: userA },
      ],
    });
  }

  async lockPairAndCheckBlock(
    manager: EntityManager,
    userA: string,
    userB: string,
  ): Promise<boolean> {
    await this.lockPair(manager, userA, userB);
    return this.isBlockedBetween(userA, userB, manager);
  }

  async getBlockedUserIds(blockerId: string): Promise<string[]> {
    const blocks = await this.dataSource.getRepository(Block).find({
      where: { blockerUserId: blockerId },
      select: { blockedUserId: true },
    });
    return blocks.map((block) => block.blockedUserId);
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return this.dataSource.getRepository(Follow).existsBy({
      followerUserId: followerId,
      followeeUserId: followeeId,
    });
  }

  async getFollowedUserIds(followerId: string): Promise<string[]> {
    const follows = await this.dataSource.getRepository(Follow).find({
      where: { followerUserId: followerId },
      select: { followeeUserId: true },
    });
    return follows.map((follow) => follow.followeeUserId);
  }

  async getRelationship(
    viewerId: string,
    otherUserId: string,
  ): Promise<RelationshipResponseDto> {
    await this.requireSocialTier(viewerId);
    if (otherUserId === viewerId) {
      throw new SelfRelationshipException();
    }
    await this.requireUser(otherUserId);
    const repo = this.dataSource.getRepository(Follow);
    const [follows, followedBy, blocked, followerCount, followingCount] =
      await Promise.all([
        repo.existsBy({
          followerUserId: viewerId,
          followeeUserId: otherUserId,
        }),
        repo.existsBy({
          followerUserId: otherUserId,
          followeeUserId: viewerId,
        }),
        this.hasBlocked(this.dataSource.manager, viewerId, otherUserId),
        repo.countBy({ followeeUserId: otherUserId }),
        repo.countBy({ followerUserId: otherUserId }),
      ]);
    return {
      userId: otherUserId,
      follows,
      followedBy,
      blocked,
      followerCount,
      followingCount,
    };
  }

  async getFeed(
    viewerId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<FeedPostResponseDto>> {
    await this.requireSocialTier(viewerId);
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;
    const params: unknown[] = [viewerId, pagination.limit + 1];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorClause =
        'AND (pp.post_created_at, pp.post_id) < ($3::timestamptz, $4::uuid)';
    }

    // Each followed user (and the viewer) contributes at most one page, read
    // straight off the partial index. A post reaches the viewer once per
    // followed participant, so the branches are deduplicated before the final
    // sort and limit.
    const rows: PostRow[] = await this.dataSource.query(
      `WITH followed AS (
        SELECT followee_user_id AS user_id FROM follows WHERE follower_user_id = $1
        UNION ALL
        SELECT $1::uuid
      )
      SELECT feed.* FROM (
        SELECT DISTINCT tp.* FROM followed CROSS JOIN LATERAL (
          SELECT ${POST_COLUMNS}
          FROM post_participants pp
          JOIN posts p ON p.id = pp.post_id
          WHERE pp.user_id = followed.user_id
            AND pp.post_is_public
            ${cursorClause}
            AND ${noBlockWithViewer('$1::uuid')}
          ORDER BY pp.post_created_at DESC, pp.post_id DESC
          LIMIT $2
        ) tp
      ) feed
      ORDER BY feed.created_at DESC, feed.id DESC
      LIMIT $2`,
      params,
    );

    const hasMore = rows.length > pagination.limit;
    const page = hasMore ? rows.slice(0, pagination.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: await this.toFeedPosts(viewerId, page),
      nextCursor:
        hasMore && last
          ? encodeCreatedAtIdCursor({
              createdAt: last.raw_created_at,
              id: last.id,
            })
          : null,
    };
  }

  async getPost(
    viewerId: string,
    transactionId: string,
  ): Promise<PostResponseDto> {
    await this.requireSocialTier(viewerId);
    const post = await this.findReadablePost(viewerId, transactionId);
    const [item] = await this.toFeedPosts(viewerId, [post]);
    if (!item) {
      throw new PostNotFoundException();
    }
    const own = item.participants.find(
      (participant) => participant.userId === viewerId,
    );
    if (!own) {
      return item;
    }
    const [mine]: { hidden: boolean }[] = await this.dataSource.query(
      `SELECT hidden FROM post_participants WHERE post_id = $1 AND user_id = $2`,
      [post.id, viewerId],
    );
    return {
      ...item,
      visibility: post.visibility,
      isPublic: post.is_public,
      published: post.published_at !== null,
      hidden: mine.hidden,
    };
  }

  async setReaction(
    userId: string,
    transactionId: string,
    reaction: Reaction,
  ): Promise<ReactionStateResponseDto> {
    await this.requireSocialTier(userId);
    const { post, isFirst } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockPostForInteraction(
          manager,
          userId,
          transactionId,
        );
        const inserted: unknown[] = await manager.query(
          `INSERT INTO post_reactions (post_id, user_id, reaction)
          VALUES ($1, $2, $3)
          ON CONFLICT (post_id, user_id) DO NOTHING
          RETURNING post_id`,
          [locked.id, userId, reaction],
        );
        if (inserted.length === 0) {
          await manager
            .getRepository(PostReaction)
            .update({ postId: locked.id, userId }, { reaction });
        }
        return { post: locked, isFirst: inserted.length > 0 };
      },
    );

    if (isFirst) {
      await this.publishPostReaction(userId, post);
    }
    return { transactionId, reaction };
  }

  async removeReaction(
    userId: string,
    transactionId: string,
  ): Promise<ReactionStateResponseDto> {
    await this.requireSocialTier(userId);
    // A reactor can withdraw their own reaction even after losing sight of
    // the post.
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(PostReaction)
      .where('user_id = :userId', { userId })
      .andWhere('post_id = :transactionId', { transactionId })
      .execute();
    if (!result.affected) {
      await this.findReadablePost(userId, transactionId);
    }
    return { transactionId, reaction: null };
  }

  async addComment(
    userId: string,
    transactionId: string,
    body: string,
  ): Promise<CommentResponseDto> {
    await this.requireSocialTier(userId);
    const { post, comment } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockPostForInteraction(
          manager,
          userId,
          transactionId,
        );
        const repo = manager.getRepository(PostComment);
        const saved = await repo.save(
          repo.create({ postId: locked.id, authorUserId: userId, body }),
        );
        return { post: locked, comment: saved };
      },
    );

    await this.publishPostComment(userId, post, comment.id);
    const author = await this.usersService.findById(userId);
    return {
      id: comment.id,
      author: toIdentitySummary(author),
      body: comment.body,
      createdAt: comment.createdAt,
    };
  }

  async listComments(
    viewerId: string,
    transactionId: string,
    cursor?: string,
  ): Promise<PaginatedResult<CommentResponseDto>> {
    await this.requireSocialTier(viewerId);
    const post = await this.findReadablePost(viewerId, transactionId);
    const after = cursor ? decodeCreatedAtIdCursor(cursor) : null;
    const params: unknown[] = [post.id, viewerId, COMMENT_PAGE_SIZE + 1];
    let cursorClause = '';
    if (after) {
      params.push(after.createdAt, after.id);
      cursorClause = 'AND (c.created_at, c.id) > ($4::timestamptz, $5::uuid)';
    }
    const rows: CommentRow[] = await this.dataSource.query(
      `SELECT c.id, c.author_user_id, c.body, c.created_at,
        c.created_at::text AS raw_created_at
      FROM post_comments c
      JOIN posts p ON p.id = c.post_id
      WHERE c.post_id = $1 AND c.deleted_at IS NULL
        ${cursorClause}
        AND ${commentVisibleTo('$2::uuid')}
      ORDER BY c.created_at, c.id
      LIMIT $3`,
      params,
    );

    const hasMore = rows.length > COMMENT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, COMMENT_PAGE_SIZE) : rows;
    const usersById = new Map(
      (
        await this.usersService.findByIds([
          ...new Set(page.map((row) => row.author_user_id)),
        ])
      ).map((user) => [user.id, user]),
    );
    const last = page[page.length - 1];
    return {
      items: page.flatMap((row) => {
        const author = usersById.get(row.author_user_id);
        return author
          ? [
              {
                id: row.id,
                author: toIdentitySummary(author),
                body: row.body,
                createdAt: row.created_at,
              },
            ]
          : [];
      }),
      nextCursor:
        hasMore && last
          ? encodeCreatedAtIdCursor({
              createdAt: last.raw_created_at,
              id: last.id,
            })
          : null,
    };
  }

  // Not gated on reading the post: the author can always withdraw their own
  // words, and participants can always moderate their own post.
  async deleteComment(userId: string, commentId: string): Promise<void> {
    await this.requireSocialTier(userId);
    const result = await this.dataSource
      .createQueryBuilder()
      .update(PostComment)
      .set({ deletedAt: () => 'now()', deletedByUserId: userId })
      .where('id = :commentId AND deleted_at IS NULL', { commentId })
      .andWhere(
        `(
          author_user_id = :userId
          OR EXISTS (
            SELECT 1 FROM post_participants pp
            WHERE pp.post_id = post_comments.post_id AND pp.user_id = :userId
          )
        )`,
        { userId },
      )
      .execute();
    if (!result.affected) {
      throw new CommentNotFoundException();
    }
  }

  private async lockPostForInteraction(
    manager: EntityManager,
    userId: string,
    transactionId: string,
  ): Promise<PostRow> {
    const found = await this.findReadablePost(userId, transactionId, manager);
    const others = (await this.loadParticipantIds(manager, found.id))
      .filter((id) => id !== userId)
      .sort();
    // Sorted so two of one user's interactions can't take the same pair
    // locks in opposite orders.
    for (const other of others) {
      await this.lockPair(manager, userId, other);
    }
    // Re-read under the pair locks so a block committed since the first
    // read is seen before anything is written.
    const locked = await this.findReadablePost(userId, transactionId, manager);
    // Participants can always read their own post, so a block with another
    // participant has to be checked here rather than by the read.
    for (const other of others) {
      if (await this.isBlockedBetween(userId, other, manager)) {
        throw new InteractionUnavailableException();
      }
    }
    return locked;
  }

  private async loadParticipantIds(
    manager: EntityManager,
    postId: string,
  ): Promise<string[]> {
    const rows: { user_id: string }[] = await manager.query(
      `SELECT user_id FROM post_participants WHERE post_id = $1`,
      [postId],
    );
    return rows.map((row) => row.user_id);
  }

  private async findReadablePost(
    viewerId: string,
    transactionId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ReadablePostRow> {
    const [post]: ReadablePostRow[] = await manager.query(
      `SELECT ${POST_COLUMNS}, p.visibility, p.is_public, p.published_at
      FROM posts p
      WHERE p.id = $2 AND ${readableBy('$1::uuid')}`,
      [viewerId, transactionId],
    );
    if (!post) {
      throw new PostNotFoundException();
    }
    return post;
  }

  private async toFeedPosts(
    viewerId: string,
    rows: PostRow[],
  ): Promise<FeedPostResponseDto[]> {
    const postIds = rows.map((row) => row.id);
    const participantRows: {
      post_id: string;
      user_id: string;
      role: ParticipantRole;
    }[] = postIds.length
      ? await this.dataSource.query(
          `SELECT post_id, user_id, role FROM post_participants WHERE post_id = ANY($1::uuid[]) ORDER BY (role = 'author') DESC, user_id`,
          [postIds],
        )
      : [];
    const userIds = [...new Set(participantRows.map((row) => row.user_id))];
    const [users, reactionsByPost, commentCounts] = await Promise.all([
      this.usersService.findByIds(userIds),
      this.loadReactions(viewerId, postIds),
      this.loadCommentCounts(viewerId, postIds),
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const participantsByPost = new Map<string, PostParticipantDto[]>();
    for (const row of participantRows) {
      const user = usersById.get(row.user_id);
      if (!user) {
        continue;
      }
      const list = participantsByPost.get(row.post_id) ?? [];
      list.push({ ...toIdentitySummary(user), role: row.role });
      participantsByPost.set(row.post_id, list);
    }
    return rows.flatMap((row) => {
      const participants = participantsByPost.get(row.id) ?? [];
      const author = participants.find(
        (participant) => participant.userId === row.author_user_id,
      );
      if (!author || participants.length < 2) {
        return [];
      }
      return [
        {
          transactionId: row.id,
          kind: row.kind,
          author: {
            userId: author.userId,
            username: author.username,
            firstName: author.firstName,
            lastName: author.lastName,
          },
          participants,
          note: row.note,
          origin: row.origin,
          createdAt: row.created_at,
          ...(reactionsByPost.get(row.id) ?? emptyReactions()),
          commentCount: commentCounts.get(row.id) ?? 0,
        },
      ];
    });
  }

  private async loadReactions(
    viewerId: string,
    postIds: string[],
  ): Promise<Map<string, PostReactions>> {
    const byPost = new Map<string, PostReactions>();
    if (postIds.length === 0) {
      return byPost;
    }
    const rows: {
      post_id: string;
      reaction: Reaction;
      count: number;
      mine: boolean;
    }[] = await this.dataSource.query(
      `SELECT r.post_id, r.reaction,
        COUNT(*) FILTER (WHERE ${notBlockedBy('r.user_id')})::int AS count,
        BOOL_OR(r.user_id = $2) AS mine
      FROM post_reactions r
      JOIN posts p ON p.id = r.post_id
      WHERE r.post_id = ANY($1::uuid[])
      GROUP BY r.post_id, r.reaction`,
      [postIds, viewerId],
    );
    for (const row of rows) {
      let entry = byPost.get(row.post_id);
      if (!entry) {
        entry = emptyReactions();
        byPost.set(row.post_id, entry);
      }
      entry.reactionCounts[row.reaction] = row.count;
      if (row.mine) {
        entry.myReaction = row.reaction;
      }
    }
    return byPost;
  }

  private async loadCommentCounts(
    viewerId: string,
    postIds: string[],
  ): Promise<Map<string, number>> {
    if (postIds.length === 0) {
      return new Map();
    }
    const rows: { post_id: string; count: number }[] =
      await this.dataSource.query(
        `SELECT c.post_id, COUNT(*)::int AS count
        FROM post_comments c
        JOIN posts p ON p.id = c.post_id
        WHERE c.post_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
          AND ${commentVisibleTo('$2::uuid')}
        GROUP BY c.post_id`,
        [postIds, viewerId],
      );
    return new Map(rows.map((row) => [row.post_id, row.count]));
  }

  private async listEdges(
    { entity, ownerColumn, otherColumn }: EdgeList,
    ownerId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;

    const query = this.dataSource
      .getRepository<Follow | Block>(entity)
      .createQueryBuilder('edge')
      // Compared as Postgres's own text form, not a millisecond JS Date, so
      // rows sharing a millisecond aren't skipped at a page boundary.
      .addSelect('"edge"."created_at"::text', 'raw_created_at')
      .where(`edge.${ownerColumn} = :ownerId`, { ownerId })
      .orderBy('edge.createdAt', 'DESC')
      .addOrderBy(`edge.${otherColumn}`, 'DESC')
      .limit(pagination.limit + 1);

    if (cursor) {
      query.andWhere(
        `(edge.createdAt, edge.${otherColumn}) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)`,
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > pagination.limit;
    const page = hasMore ? entities.slice(0, pagination.limit) : entities;
    const otherIds = page.map(
      (edge) => (edge as unknown as Record<string, string>)[otherColumn],
    );
    const usersById = new Map(
      (await this.usersService.findByIds(otherIds)).map((user) => [
        user.id,
        user,
      ]),
    );
    const last = page[page.length - 1];

    return {
      items: otherIds
        .map((id) => usersById.get(id))
        .filter((user) => user !== undefined)
        .map(toIdentitySummary),
      nextCursor:
        hasMore && last
          ? encodeCreatedAtIdCursor({
              createdAt: raw[page.length - 1].raw_created_at,
              id: otherIds[otherIds.length - 1],
            })
          : null,
    };
  }

  // Taken by everything that writes or checks a block between a pair, so
  // none of it can interleave with a block: whichever commits second sees
  // what the first wrote.
  private async lockPair(
    manager: EntityManager,
    userA: string,
    userB: string,
  ): Promise<void> {
    const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `social-pair:${low}:${high}`,
    ]);
  }

  private async hasBlocked(
    manager: EntityManager,
    blockerId: string,
    blockedId: string,
  ): Promise<boolean> {
    return manager
      .getRepository(Block)
      .existsBy({ blockerUserId: blockerId, blockedUserId: blockedId });
  }

  private async requireSocialTier(userId: string): Promise<void> {
    const tier = await this.usersService.getKycTier(
      this.dataSource.manager,
      userId,
    );
    if (tier === 'tier0') {
      throw new SocialKycRequiredException();
    }
  }

  private async requireUser(userId: string): Promise<void> {
    const [user] = await this.usersService.findByIds([userId]);
    if (!user) {
      throw new SocialUserNotFoundException();
    }
  }

  private async publishNewFollower(
    followerId: string,
    followeeId: string,
  ): Promise<void> {
    try {
      const follower = await this.usersService.findById(followerId);
      await this.eventBus.publish<string, NewFollowerEventPayload>({
        name: NEW_FOLLOWER_EVENT,
        payload: {
          userId: followeeId,
          followerUserId: followerId,
          followerUsername: follower.username,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishNewFollower: ${followerId} followed ${followeeId}, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async notificationRecipients(
    post: PostRow,
    actorId: string,
  ): Promise<string[]> {
    const candidates =
      post.kind === 'bill_split'
        ? [post.author_user_id]
        : await this.loadParticipantIds(this.dataSource.manager, post.id);
    return candidates.filter((id) => id !== actorId);
  }

  private async publishPostReaction(
    reactorId: string,
    post: PostRow,
  ): Promise<void> {
    try {
      const recipients = await this.notificationRecipients(post, reactorId);
      const reactor = await this.usersService.findById(reactorId);
      for (const userId of recipients) {
        await this.eventBus.publish<string, PostReactionEventPayload>({
          name: POST_REACTION_EVENT,
          payload: {
            userId,
            transactionId: post.id,
            reactorUserId: reactorId,
            reactorUsername: reactor.username,
          },
          occurredAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(
        `publishPostReaction: ${reactorId} reacted to ${post.id}, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishPostComment(
    commenterId: string,
    post: PostRow,
    commentId: string,
  ): Promise<void> {
    try {
      const recipients = await this.notificationRecipients(post, commenterId);
      const commenter = await this.usersService.findById(commenterId);
      for (const userId of recipients) {
        await this.eventBus.publish<string, PostCommentEventPayload>({
          name: POST_COMMENT_EVENT,
          payload: {
            userId,
            transactionId: post.id,
            commentId,
            commenterUserId: commenterId,
            commenterUsername: commenter.username,
          },
          occurredAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(
        `publishPostComment: ${commenterId} commented on ${post.id}, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
