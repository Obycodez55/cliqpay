import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, SelectQueryBuilder } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { Money } from '../../shared/primitives/money';
import { toIdentitySummary } from '../../common/dto/identity-summary.dto';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import {
  BILL_SPLIT_COMPLETED_EVENT,
  BillSplitCompletedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  SplitRequestRecord,
  TransfersService,
} from '../transfers/transfers.service';
import { SocialService } from '../social/social.service';
import { UsersService } from '../users/users.service';
import { CreateBillSplitDto } from './dto/create-bill-split.dto';
import {
  BillSplitApiStatus,
  BillSplitListItemDto,
  BillSplitResponseDto,
} from './dto/bill-split-response.dto';
import { ListBillSplitsQueryDto } from './dto/list-bill-splits-query.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { BillSplit } from './entities/bill-split.entity';
import { BillSplitParticipant } from './entities/bill-split-participant.entity';
import {
  BillSplitNotFoundException,
  BillSplitNotOpenException,
  BillSplitParticipantsInvalidException,
  BillSplitReferenceReusedException,
} from './internal/errors';
import { ComputedShares, computeShares } from './internal/shares';
import {
  SplitOutcome,
  deriveOutcome,
  deriveSplitStatus,
} from './internal/split-status';

const NGN = 'NGN';
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_REFERENCE = 'UQ_bill_splits_initiator_user_id_reference';

interface WriteSplitParams {
  initiatorId: string;
  dto: CreateBillSplitDto;
  computed: ComputedShares;
  expiresAt: Date;
  now: Date;
}

@Injectable()
export class BillSplitService {
  private readonly logger = new Logger(BillSplitService.name);

  constructor(
    // @InjectDataSource: creation writes the split, its participants, its
    // money requests and its post in one transaction.
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transfersService: TransfersService,
    private readonly usersService: UsersService,
    private readonly socialService: SocialService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createSplit(
    initiatorId: string,
    dto: CreateBillSplitDto,
  ): Promise<BillSplitResponseDto> {
    const participantIds = dto.participants.map((p) => p.userId);
    if (participantIds.includes(initiatorId)) {
      throw new BillSplitParticipantsInvalidException(
        'You cannot be a participant in your own split; your share is counted automatically',
      );
    }
    if (new Set(participantIds).size !== participantIds.length) {
      throw new BillSplitParticipantsInvalidException(
        'Participants must be distinct',
      );
    }
    const { maxParticipants } = this.config.billSplits;
    if (participantIds.length > maxParticipants) {
      throw new BillSplitParticipantsInvalidException(
        `A split can have at most ${maxParticipants} participants`,
      );
    }

    const computed = computeShares(
      dto.mode,
      Money.of(dto.total, NGN),
      dto.participants,
      Money.of(this.config.transfers.minAmount, NGN),
    );

    const replayed = await this.findReplay(initiatorId, dto, computed);
    if (replayed) {
      return this.loadView(replayed);
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.moneyRequests.expiryDays * DAY_MS,
    );

    let created: { splitId: string; requests: SplitRequestRecord[] };
    try {
      created = await runInTransaction(this.dataSource, (manager) =>
        this.writeSplit(manager, {
          initiatorId,
          dto,
          computed,
          expiresAt,
          now,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, UNIQUE_REFERENCE)) {
        const raced = await this.findReplay(initiatorId, dto, computed);
        if (raced) {
          return this.loadView(raced);
        }
      }
      throw error;
    }

    await this.transfersService.publishSplitRequestsCreated(
      initiatorId,
      created.requests,
    );
    return this.loadView(created.splitId);
  }

  // Visible to the initiator and the participants; everyone else, and a
  // missing id, get the same 404.
  async getSplit(
    viewerId: string,
    splitId: string,
  ): Promise<BillSplitResponseDto> {
    const view = await this.loadView(splitId);
    const isMember =
      view.initiator.userId === viewerId ||
      view.participants.some((p) => p.userId === viewerId);
    if (!isMember) {
      throw new BillSplitNotFoundException();
    }
    return view;
  }

  // Initiator only; anyone else, and a missing id, get the same 404. The
  // split row is locked first and the request rows second (in id order), so
  // a concurrent payment either commits before the bulk cancel locks its
  // request, and that share stays paid, or waits and then finds it cancelled.
  async cancelSplit(
    initiatorId: string,
    splitId: string,
  ): Promise<BillSplitResponseDto> {
    const now = new Date();
    const cancelled = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const splitRepo = manager.getRepository(BillSplit);
        const split = await splitRepo.findOne({
          where: { id: splitId, initiatorUserId: initiatorId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!split) {
          throw new BillSplitNotFoundException();
        }
        const participants = await manager
          .getRepository(BillSplitParticipant)
          .findBy({ billSplitId: splitId });
        const requests = await this.transfersService.findMoneyRequestsByIds(
          participants.map((p) => p.moneyRequestId),
        );
        if (
          deriveSplitStatus(
            split,
            requests.map((r) => r.status),
            now,
          ) !== 'open'
        ) {
          throw new BillSplitNotOpenException();
        }
        const cancelledRequests =
          await this.transfersService.cancelPendingRequests(
            manager,
            initiatorId,
            participants.map((p) => p.moneyRequestId),
            now,
          );
        if (cancelledRequests.length === 0) {
          throw new BillSplitNotOpenException();
        }
        await splitRepo.update({ id: splitId }, { cancelledAt: now });
        return cancelledRequests;
      },
    );

    await this.transfersService.publishRequestsCancelled(cancelled);
    return this.loadView(splitId);
  }

  async listSplits(
    userId: string,
    query: ListBillSplitsQueryDto,
  ): Promise<PaginatedResult<BillSplitListItemDto>> {
    const cursor = query.cursor ? decodeCreatedAtIdCursor(query.cursor) : null;

    const qb = this.dataSource
      .getRepository(BillSplit)
      .createQueryBuilder('split')
      .addSelect('"split"."created_at"::text', 'raw_created_at')
      .orderBy('split.createdAt', 'DESC')
      .addOrderBy('split.id', 'DESC')
      .limit(query.limit + 1);

    if (query.role === 'initiator') {
      qb.where('split.initiatorUserId = :userId', { userId });
    } else {
      qb.innerJoin(
        BillSplitParticipant,
        'mine',
        'mine.billSplitId = split.id AND mine.userId = :userId',
        { userId },
      );
    }

    this.applyStatusFilter(qb, query.status, new Date());

    if (cursor) {
      qb.andWhere(
        '(split.createdAt, split.id) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await qb.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > query.limit;
    const page = hasMore ? entities.slice(0, query.limit) : entities;
    const views = await this.buildViews(page);

    const items = views.map((view) => {
      const mine =
        query.role === 'participant'
          ? view.participants.find((p) => p.userId === userId)
          : undefined;
      return {
        ...view,
        moneyRequestId: mine?.moneyRequestId ?? null,
        share: mine?.share ?? null,
      };
    });
    return {
      items,
      nextCursor: hasMore
        ? encodeCreatedAtIdCursor({
            createdAt: raw[query.limit - 1].raw_created_at,
            id: page[page.length - 1].id,
          })
        : null,
    };
  }

  // The stored-column mirror of deriveSplitStatus: cancelled, then completed,
  // then closed, then (nothing recorded) expired or open by expires_at.
  private applyStatusFilter(
    qb: SelectQueryBuilder<BillSplit>,
    status: BillSplitApiStatus | undefined,
    now: Date,
  ): void {
    switch (status) {
      case 'cancelled':
        qb.andWhere('split.cancelledAt IS NOT NULL');
        return;
      case 'completed':
        qb.andWhere(
          'split.cancelledAt IS NULL AND split.completedAt IS NOT NULL',
        );
        return;
      case 'closed':
        qb.andWhere(
          'split.cancelledAt IS NULL AND split.completedAt IS NULL AND split.closedAt IS NOT NULL',
        );
        return;
      case 'expired':
      case 'open': {
        qb.andWhere(
          'split.cancelledAt IS NULL AND split.completedAt IS NULL AND split.closedAt IS NULL',
        );
        qb.andWhere(
          status === 'expired'
            ? 'split.expiresAt < :now'
            : 'split.expiresAt >= :now',
          { now },
        );
        return;
      }
      default:
        return;
    }
  }

  // The row lock serialises the event handler and read-repair, and the
  // timestamp is only written while still null, so exactly one caller records
  // the outcome and publishes the completion. The post is published in the
  // same transaction, taking its row lock after the split's.
  async recordOutcome(splitId: string): Promise<SplitOutcome | null> {
    const recorded = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const split = await manager.getRepository(BillSplit).findOne({
          where: { id: splitId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !split ||
          split.cancelledAt ||
          split.completedAt ||
          split.closedAt
        ) {
          return null;
        }
        const participants = await manager
          .getRepository(BillSplitParticipant)
          .findBy({ billSplitId: splitId });
        const requests = await this.transfersService.findMoneyRequestsByIds(
          participants.map((p) => p.moneyRequestId),
        );
        const outcome =
          requests.length === participants.length
            ? deriveOutcome(requests.map((r) => r.status))
            : null;
        if (!outcome) {
          return null;
        }
        await manager
          .getRepository(BillSplit)
          .update(
            { id: splitId },
            outcome === 'completed'
              ? { completedAt: new Date() }
              : { closedAt: new Date() },
          );
        if (outcome === 'completed') {
          await this.socialService.publishPost(manager, splitId);
        }
        return { outcome, split };
      },
    );
    if (recorded?.outcome === 'completed') {
      await this.publishCompleted(recorded.split);
    }
    return recorded?.outcome ?? null;
  }

  private async publishCompleted(split: BillSplit): Promise<void> {
    try {
      await this.eventBus.publish<string, BillSplitCompletedEventPayload>({
        name: BILL_SPLIT_COMPLETED_EVENT,
        payload: {
          userId: split.initiatorUserId,
          billSplitId: split.id,
          description: split.description,
          total: Money.of(split.totalAmount, split.currency).toDecimalString(),
          currency: split.currency,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishCompleted: split ${split.id} was recorded as completed, but publishing bill_split_completed failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async repairOutcome(splitId: string): Promise<void> {
    try {
      await this.recordOutcome(splitId);
    } catch (error) {
      this.logger.error(
        `repairOutcome: recording the outcome of split ${splitId} failed (${(error as Error).message})`,
      );
    }
  }

  private async writeSplit(
    manager: EntityManager,
    params: WriteSplitParams,
  ): Promise<{ splitId: string; requests: SplitRequestRecord[] }> {
    const { initiatorId, dto, computed } = params;
    const splitRepo = manager.getRepository(BillSplit);
    const split = await splitRepo.save(
      splitRepo.create({
        initiatorUserId: initiatorId,
        reference: dto.reference,
        description: dto.description,
        mode: dto.mode,
        totalAmount: BigInt(dto.total),
        initiatorShare: computed.initiatorShare.amount,
        currency: NGN,
        expiresAt: params.expiresAt,
      }),
    );

    const requests = await this.transfersService.createSplitRequests(manager, {
      requesterId: initiatorId,
      shares: computed.shares.map((share) => ({
        payerUserId: share.userId,
        amount: Number(share.amount.amount),
      })),
      note: dto.description,
      expiresAt: params.expiresAt,
      now: params.now,
    });

    await manager.getRepository(BillSplitParticipant).insert(
      requests.map((request) => ({
        billSplitId: split.id,
        userId: request.payerUserId,
        amount: request.amount,
        moneyRequestId: request.id,
      })),
    );

    await this.socialService.createPost(manager, {
      kind: 'bill_split',
      id: split.id,
      authorUserId: initiatorId,
      participants: requests.map((request) => ({
        userId: request.payerUserId,
        role: 'member' as const,
      })),
      note: dto.description,
      visibility: dto.visibility,
      published: false,
    });
    return { splitId: split.id, requests };
  }

  // The original split's id when this initiator already used `reference`
  // with the same contents, null when the reference is new, and a 409 when
  // the contents differ.
  private async findReplay(
    initiatorId: string,
    dto: CreateBillSplitDto,
    computed: ComputedShares,
  ): Promise<string | null> {
    const existing = await this.dataSource.getRepository(BillSplit).findOneBy({
      initiatorUserId: initiatorId,
      reference: dto.reference,
    });
    if (!existing) {
      return null;
    }
    const stored = await this.dataSource
      .getRepository(BillSplitParticipant)
      .findBy({ billSplitId: existing.id });
    const postVisibility = (
      await this.socialService.getVisibilities([existing.id])
    ).get(existing.id);
    const storedShares = new Map(stored.map((p) => [p.userId, p.amount]));
    const same =
      existing.mode === dto.mode &&
      existing.totalAmount === BigInt(dto.total) &&
      existing.description === dto.description &&
      postVisibility?.requested === dto.visibility &&
      storedShares.size === computed.shares.length &&
      computed.shares.every(
        (share) => storedShares.get(share.userId) === share.amount.amount,
      );
    if (!same) {
      throw new BillSplitReferenceReusedException();
    }
    return existing.id;
  }

  private async loadView(splitId: string): Promise<BillSplitResponseDto> {
    const split = await this.dataSource
      .getRepository(BillSplit)
      .findOneBy({ id: splitId });
    if (!split) {
      throw new BillSplitNotFoundException();
    }
    const [view] = await this.buildViews([split]);
    return view;
  }

  // One batched read of participants, requests and users for any number of
  // splits, so a list page costs the same queries as a single view.
  private async buildViews(
    splits: BillSplit[],
  ): Promise<BillSplitResponseDto[]> {
    if (splits.length === 0) {
      return [];
    }
    const allParticipants = await this.dataSource
      .getRepository(BillSplitParticipant)
      .findBy({ billSplitId: In(splits.map((s) => s.id)) });
    allParticipants.sort((a, b) => (a.userId < b.userId ? -1 : 1));

    const [requests, users] = await Promise.all([
      this.transfersService.findMoneyRequestsByIds(
        allParticipants.map((p) => p.moneyRequestId),
      ),
      this.usersService.findByIds([
        ...new Set([
          ...splits.map((s) => s.initiatorUserId),
          ...allParticipants.map((p) => p.userId),
        ]),
      ]),
    ]);
    const visibilities = await this.socialService.getVisibilities(
      splits.map((s) => s.id),
    );
    const requestById = new Map(requests.map((r) => [r.id, r]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const now = new Date();

    const views: BillSplitResponseDto[] = [];
    for (const split of splits) {
      const initiator = userById.get(split.initiatorUserId);
      if (!initiator) {
        throw new Error(
          `BillSplitService.buildViews: initiator ${split.initiatorUserId} not found for split ${split.id}`,
        );
      }

      const rows = allParticipants
        .filter((p) => p.billSplitId === split.id)
        .map((participant) => {
          const user = userById.get(participant.userId);
          const request = requestById.get(participant.moneyRequestId);
          if (!user || !request) {
            throw new Error(
              `BillSplitService.buildViews: participant ${participant.userId} or request ${participant.moneyRequestId} not found for split ${split.id}`,
            );
          }
          return {
            ...toIdentitySummary(user),
            share: Money.of(participant.amount, split.currency).toJSON(),
            moneyRequestId: participant.moneyRequestId,
            status: request.status,
          };
        });

      const statuses = rows.map((row) => row.status);
      const outcome = deriveOutcome(statuses);
      const recorded =
        outcome === 'completed' ? split.completedAt : split.closedAt;
      if (outcome && !recorded && !split.cancelledAt) {
        await this.repairOutcome(split.id);
      }

      const postVisibility = visibilities.get(split.id);
      if (!postVisibility) {
        throw new Error(
          `BillSplitService.buildViews: post not found for split ${split.id}`,
        );
      }

      views.push({
        id: split.id,
        description: split.description,
        mode: split.mode,
        total: Money.of(split.totalAmount, split.currency).toJSON(),
        initiatorShare: Money.of(split.initiatorShare, split.currency).toJSON(),
        initiator: toIdentitySummary(initiator),
        status: deriveSplitStatus(split, statuses, now),
        visibility: postVisibility.visibility,
        participants: rows,
        expiresAt: split.expiresAt.toISOString(),
        createdAt: split.createdAt.toISOString(),
      });
    }
    return views;
  }
}
