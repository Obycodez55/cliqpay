import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
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
import {
  PostStateResponseDto,
  toPostStateResponse,
} from './dto/post-state-response.dto';
import {
  POST_VISIBILITIES,
  PostVisibility,
  TransactionPost,
} from './entities/transaction-post.entity';
import { Follow } from './entities/follow.entity';
import { Block } from './entities/block.entity';
import { FollowStateResponseDto } from './dto/follow-state-response.dto';
import { BlockStateResponseDto } from './dto/block-state-response.dto';
import { RelationshipResponseDto } from './dto/relationship-response.dto';
import {
  FeedPostResponseDto,
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
  PostNotFoundException,
  SelfBlockException,
  SelfFollowException,
  SocialKycRequiredException,
  SocialUserNotFoundException,
} from './internal/errors';

const MAX_FOLLOWING = 5_000;
const COMMENT_PAGE_SIZE = 20;

export { POST_VISIBILITIES };
export type { PostVisibility };

export interface RecordTransferPostParams {
  transactionId: string;
  senderUserId: string;
  recipientUserId: string;
  note: string | null;
  visibility: PostVisibility;
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

function notAuthoredByBlockedOf(viewerParam: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_user_id = ${viewerParam}
      AND b.blocked_user_id = c.author_user_id
  )`;
}

interface PostRow {
  id: string;
  transaction_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  note: string | null;
  created_at: Date;
  raw_created_at: string;
}

const POST_COLUMNS = `p.id, p.transaction_id, p.sender_user_id, p.recipient_user_id,
  p.note, p.created_at, p.created_at::text AS raw_created_at`;

// Must stay literal, not parameterised, for the planner to match the
// partial indexes' predicate.
const EFFECTIVELY_PUBLIC = `p.visibility = 'public' AND p.hidden_by_recipient = false`;

function noBlockWithViewer(viewerParam: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_user_id = ${viewerParam}
      AND b.blocked_user_id IN (p.sender_user_id, p.recipient_user_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_user_id IN (p.sender_user_id, p.recipient_user_id)
      AND b.blocked_user_id = ${viewerParam}
  )`;
}

function readableBy(viewerParam: string): string {
  return `(
    ${viewerParam} IN (p.sender_user_id, p.recipient_user_id)
    OR (
      ${EFFECTIVELY_PUBLIC}
      AND EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_user_id = ${viewerParam}
          AND f.followee_user_id IN (p.sender_user_id, p.recipient_user_id)
      )
      AND ${noBlockWithViewer(viewerParam)}
    )
  )`;
}

function feedBranch(
  participantColumn: string,
  cursorClause: string,
  limitParam: string,
): string {
  return `SELECT tp.* FROM followed CROSS JOIN LATERAL (
    SELECT ${POST_COLUMNS}
    FROM transaction_posts p
    WHERE p.${participantColumn} = followed.user_id
      AND ${EFFECTIVELY_PUBLIC}
      ${cursorClause}
      AND ${noBlockWithViewer('$1::uuid')}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limitParam}
  ) tp`;
}

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
  ) {}

  async recordTransferPost(
    manager: EntityManager,
    params: RecordTransferPostParams,
  ): Promise<void> {
    const repo = manager.getRepository(TransactionPost);
    await repo.insert(
      repo.create({
        transactionId: params.transactionId,
        senderUserId: params.senderUserId,
        recipientUserId: params.recipientUserId,
        note: params.note,
        visibility: params.visibility,
        requestedVisibility: params.visibility,
        hiddenByRecipient: false,
      }),
    );
  }

  async getRequestedVisibility(
    transactionId: string,
  ): Promise<PostVisibility | null> {
    const post = await this.dataSource.getRepository(TransactionPost).findOne({
      where: { transactionId },
      select: { requestedVisibility: true },
    });
    return post?.requestedVisibility ?? null;
  }

  async setVisibility(
    senderId: string,
    transactionId: string,
    visibility: PostVisibility,
  ): Promise<PostStateResponseDto> {
    const repo = this.dataSource.getRepository(TransactionPost);
    const post = await repo.findOneBy({
      transactionId,
      senderUserId: senderId,
    });
    if (!post) {
      throw new PostNotFoundException();
    }
    post.visibility = visibility;
    return toPostStateResponse(await repo.save(post));
  }

  async setHiddenByRecipient(
    recipientId: string,
    transactionId: string,
    hidden: boolean,
  ): Promise<PostStateResponseDto> {
    const repo = this.dataSource.getRepository(TransactionPost);
    const post = await repo.findOneBy({
      transactionId,
      recipientUserId: recipientId,
    });
    if (!post) {
      throw new PostNotFoundException();
    }
    post.hiddenByRecipient = hidden;
    return toPostStateResponse(await repo.save(post));
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
      if (await this.isBlockedBetween(followerId, followeeId, manager)) {
        throw new SocialUserNotFoundException();
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
      cursorClause = 'AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)';
    }

    // Each followed user (and the viewer) contributes at most one page from
    // each side, read straight off the partial indexes, so the merge below
    // never sorts more than (follows + 1) * 2 pages of rows.
    const rows: PostRow[] = await this.dataSource.query(
      `WITH followed AS (
        SELECT followee_user_id AS user_id FROM follows WHERE follower_user_id = $1
        UNION ALL
        SELECT $1::uuid
      )
      SELECT feed.* FROM (
        ${feedBranch('sender_user_id', cursorClause, '$2')}
        UNION
        ${feedBranch('recipient_user_id', cursorClause, '$2')}
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
  ): Promise<FeedPostResponseDto> {
    await this.requireSocialTier(viewerId);
    const post = await this.findReadablePost(viewerId, transactionId);
    const [item] = await this.toFeedPosts(viewerId, [post]);
    if (!item) {
      throw new PostNotFoundException();
    }
    return item;
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
        const found = await this.findReadablePost(
          userId,
          transactionId,
          manager,
        );
        const others = [found.sender_user_id, found.recipient_user_id]
          .filter((id) => id !== userId)
          .sort();
        // Sorted so two of one user's reactions can't take the same pair
        // locks in opposite orders.
        for (const other of others) {
          await this.lockPair(manager, userId, other);
        }
        // Re-read under the pair locks so a block committed since the
        // first read is seen before the reaction is written.
        const locked = await this.findReadablePost(
          userId,
          transactionId,
          manager,
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
    const post = await this.findReadablePost(userId, transactionId);
    await this.dataSource
      .getRepository(PostReaction)
      .delete({ postId: post.id, userId });
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
        const found = await this.findReadablePost(
          userId,
          transactionId,
          manager,
        );
        const others = [found.sender_user_id, found.recipient_user_id]
          .filter((id) => id !== userId)
          .sort();
        for (const other of others) {
          await this.lockPair(manager, userId, other);
        }
        const locked = await this.findReadablePost(
          userId,
          transactionId,
          manager,
        );
        // Participants can always read their own post, so a block with the
        // counterparty has to be checked here rather than by the read.
        for (const other of others) {
          if (await this.isBlockedBetween(userId, other, manager)) {
            throw new PostNotFoundException();
          }
        }
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
      WHERE c.post_id = $1 AND c.deleted_at IS NULL
        ${cursorClause}
        AND ${notAuthoredByBlockedOf('$2::uuid')}
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
        `EXISTS (
          SELECT 1 FROM transaction_posts p
          WHERE p.id = post_id
            AND :userId IN (author_user_id, p.sender_user_id, p.recipient_user_id)
        )`,
        { userId },
      )
      .execute();
    if (!result.affected) {
      throw new CommentNotFoundException();
    }
  }

  private async findReadablePost(
    viewerId: string,
    transactionId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<PostRow> {
    const [post]: PostRow[] = await manager.query(
      `SELECT ${POST_COLUMNS}
      FROM transaction_posts p
      WHERE p.transaction_id = $2 AND ${readableBy('$1::uuid')}`,
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
    const userIds = [
      ...new Set(
        rows.flatMap((row) => [row.sender_user_id, row.recipient_user_id]),
      ),
    ];
    const postIds = rows.map((row) => row.id);
    const [users, reactionsByPost, commentCounts] = await Promise.all([
      this.usersService.findByIds(userIds),
      this.loadReactions(viewerId, postIds),
      this.loadCommentCounts(viewerId, postIds),
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    return rows.flatMap((row) => {
      const sender = usersById.get(row.sender_user_id);
      const recipient = usersById.get(row.recipient_user_id);
      if (!sender || !recipient) {
        return [];
      }
      return [
        {
          transactionId: row.transaction_id,
          sender: toIdentitySummary(sender),
          recipient: toIdentitySummary(recipient),
          note: row.note,
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
      `SELECT post_id, reaction, COUNT(*)::int AS count,
        BOOL_OR(user_id = $2) AS mine
      FROM post_reactions
      WHERE post_id = ANY($1::uuid[])
      GROUP BY post_id, reaction`,
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
        WHERE c.post_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
          AND ${notAuthoredByBlockedOf('$2::uuid')}
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

  // Shared by follow and block so the two can't interleave for a pair:
  // whichever commits second sees what the first wrote.
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

  private async publishPostReaction(
    reactorId: string,
    post: PostRow,
  ): Promise<void> {
    const recipients = [
      ...new Set([post.sender_user_id, post.recipient_user_id]),
    ].filter((id) => id !== reactorId);
    try {
      const reactor = await this.usersService.findById(reactorId);
      for (const userId of recipients) {
        await this.eventBus.publish<string, PostReactionEventPayload>({
          name: POST_REACTION_EVENT,
          payload: {
            userId,
            transactionId: post.transaction_id,
            reactorUserId: reactorId,
            reactorUsername: reactor.username,
          },
          occurredAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(
        `publishPostReaction: ${reactorId} reacted to ${post.transaction_id}, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishPostComment(
    commenterId: string,
    post: PostRow,
    commentId: string,
  ): Promise<void> {
    const recipients = [
      ...new Set([post.sender_user_id, post.recipient_user_id]),
    ].filter((id) => id !== commenterId);
    try {
      const commenter = await this.usersService.findById(commenterId);
      for (const userId of recipients) {
        await this.eventBus.publish<string, PostCommentEventPayload>({
          name: POST_COMMENT_EVENT,
          payload: {
            userId,
            transactionId: post.transaction_id,
            commentId,
            commenterUserId: commenterId,
            commenterUsername: commenter.username,
          },
          occurredAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(
        `publishPostComment: ${commenterId} commented on ${post.transaction_id}, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
