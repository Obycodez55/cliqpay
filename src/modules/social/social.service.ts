import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { UsersService } from '../users/users.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  NEW_FOLLOWER_EVENT,
  NewFollowerEventPayload,
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
  FollowLimitReachedException,
  FollowRequiresUnblockException,
  PostNotFoundException,
  SelfBlockException,
  SelfFollowException,
  SocialKycRequiredException,
  SocialUserNotFoundException,
} from './internal/errors';

const MAX_FOLLOWING = 5_000;

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
}
