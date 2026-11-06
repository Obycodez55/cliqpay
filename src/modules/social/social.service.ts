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
import { FollowStateResponseDto } from './dto/follow-state-response.dto';
import { RelationshipResponseDto } from './dto/relationship-response.dto';
import {
  FollowLimitReachedException,
  PostNotFoundException,
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

type FollowListSide = 'followers' | 'following';

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
    return this.listFollows(userId, 'followers', pagination);
  }

  async listFollowing(
    userId: string,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    await this.requireSocialTier(userId);
    return this.listFollows(userId, 'following', pagination);
  }

  async getRelationship(
    viewerId: string,
    otherUserId: string,
  ): Promise<RelationshipResponseDto> {
    await this.requireSocialTier(viewerId);
    await this.requireUser(otherUserId);
    const repo = this.dataSource.getRepository(Follow);
    const [follows, followedBy, followerCount, followingCount] =
      await Promise.all([
        repo.existsBy({
          followerUserId: viewerId,
          followeeUserId: otherUserId,
        }),
        repo.existsBy({
          followerUserId: otherUserId,
          followeeUserId: viewerId,
        }),
        repo.countBy({ followeeUserId: otherUserId }),
        repo.countBy({ followerUserId: otherUserId }),
      ]);
    return {
      userId: otherUserId,
      follows,
      followedBy,
      followerCount,
      followingCount,
    };
  }

  private async listFollows(
    ownerId: string,
    side: FollowListSide,
    pagination: SocialPagination,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;
    const ownerColumn =
      side === 'followers' ? 'followeeUserId' : 'followerUserId';
    const otherColumn =
      side === 'followers' ? 'followerUserId' : 'followeeUserId';

    const query = this.dataSource
      .getRepository(Follow)
      .createQueryBuilder('follow')
      // Compared as Postgres's own text form, not a millisecond JS Date, so
      // rows sharing a millisecond aren't skipped at a page boundary.
      .addSelect('"follow"."created_at"::text', 'raw_created_at')
      .where(`follow.${ownerColumn} = :ownerId`, { ownerId })
      .orderBy('follow.createdAt', 'DESC')
      .addOrderBy(`follow.${otherColumn}`, 'DESC')
      .limit(pagination.limit + 1);

    if (cursor) {
      query.andWhere(
        `(follow.createdAt, follow.${otherColumn}) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)`,
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > pagination.limit;
    const page = hasMore ? entities.slice(0, pagination.limit) : entities;
    const otherIds = page.map((follow) => follow[otherColumn]);
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
              id: last[otherColumn],
            })
          : null,
    };
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
