import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  WhereExpressionBuilder,
} from 'typeorm';
import { EntityNotFoundError } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { UsersService } from '../users/users.service';
import { KycService } from '../kyc/kyc.service';
import { LedgerService } from '../ledger/ledger.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  MONEY_REQUEST_CANCELLED_EVENT,
  MONEY_REQUEST_CREATED_EVENT,
  MONEY_REQUEST_DECLINED_EVENT,
  MONEY_REQUEST_PAID_EVENT,
  MoneyRequestCancelledEventPayload,
  MoneyRequestCreatedEventPayload,
  MoneyRequestDeclinedEventPayload,
  MoneyRequestPaidEventPayload,
} from '../../shared/events/domain-events';
import { Money } from '../../shared/primitives/money';
import { toIdentitySummary } from '../../common/dto/identity-summary.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { runInTransaction } from '../../database/transaction.util';
import { MoneyRequest } from './entities/money-request.entity';
import { CreateMoneyRequestDto } from './dto/create-money-request.dto';
import { PayMoneyRequestDto } from './dto/pay-money-request.dto';
import { IncomingBucket } from './dto/list-incoming-money-requests-query.dto';
import {
  MoneyRequestResponseDto,
  toMoneyRequestResponse,
} from './dto/money-request-response.dto';
import { TransfersService } from './transfers.service';
import { SocialService } from '../social/social.service';
import {
  MoneyRequestAmountTooSmallException,
  MoneyRequestNotFoundException,
  MoneyRequestNotPayableException,
  MoneyRequestPairCapExceededException,
  PayerNotFoundException,
  RecipientUnableToReceiveException,
  SelfMoneyRequestException,
} from './internal/errors';

const NGN = 'NGN'; // Same scope as transfers this phase — see docs/architecture.md §6 Phase 3.

// Structural, not the `User` entity type — this module reaches users only
// through UsersService's exported surface (docs/architecture.md §10), same
// convention as TransfersService's own `sender`/recipientWallet typing.
type CounterpartyUser = Awaited<ReturnType<UsersService['findById']>>;

export interface MoneyRequestListPagination {
  cursor?: string;
  limit: number;
}

interface RequesterFilter {
  hiddenPendingFrom: string[];
  bucket?: { kind: IncomingBucket; followedIds: string[] };
}

// Applied to every query that treats a request as still actionable — a
// `pending` row whose `expiresAt` has passed presents as expired but is
// never rewritten (ADR-0012), so `status = 'pending'` alone is wrong
// everywhere: the pair cap, cancel, and decline all go through this one
// helper instead of three separately-reasoned-about WHERE clauses that
// could drift.
function applyEffectivelyPending<T extends WhereExpressionBuilder>(
  qb: T,
  alias: string,
  now: Date,
): T {
  return qb
    .andWhere(`${alias}.status = :pendingStatus`, { pendingStatus: 'pending' })
    .andWhere(`${alias}.expiresAt > :now`, { now });
}

// Same predicate as applyEffectivelyPending above, evaluated against an
// already-fetched row rather than as a SQL WHERE clause — the callers lock
// the row first and then decide, and payRequest needs the row regardless of
// its status (a paid row must still be fetchable, to detect an idempotent
// replay).
function isEffectivelyPending(moneyRequest: MoneyRequest, now: Date): boolean {
  return moneyRequest.status === 'pending' && moneyRequest.expiresAt > now;
}

/**
 * A peer to TransfersService within the same module, not a standalone
 * module — money requests are a genuinely distinct responsibility (own
 * table, own state machine, no ledger posting at creation) but not a
 * distinct module boundary: #25 (pay a request) is about to add to
 * whichever surface owns this, and TransfersModule already exists to hold
 * exactly this kind of "distinct but same-boundary" growth (see
 * docs/adr/0011-transfers-module-boundary.md's neighbor precedent —
 * AuthModule's MfaService/SessionService/TransactionPinService). Internal
 * to the module, same as those — TransfersModule still exports only
 * TransfersService.
 */
@Injectable()
export class MoneyRequestsService {
  private readonly logger = new Logger(MoneyRequestsService.name);

  constructor(
    // @InjectDataSource, not @InjectRepository — payRequest below runs a
    // multi-step atomic write (lock the request row, post the transfer,
    // flip status, all in one DB transaction), so this service needs
    // transaction-scoped repository access the same way ledger.service.ts
    // and auth's transacting services do (CLAUDE.md's repository-access
    // rule).
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly transfersService: TransfersService,
    private readonly kycService: KycService,
    private readonly ledgerService: LedgerService,
    private readonly socialService: SocialService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get moneyRequests(): Repository<MoneyRequest> {
    return this.dataSource.getRepository(MoneyRequest);
  }

  async createRequest(
    requesterId: string,
    dto: CreateMoneyRequestDto,
  ): Promise<MoneyRequestResponseDto> {
    const { minAmount } = this.config.transfers;
    if (dto.amount < minAmount) {
      throw new MoneyRequestAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (dto.payerUserId === requesterId) {
      throw new SelfMoneyRequestException();
    }

    await this.kycService.checkCanReceive(
      this.dataSource.manager,
      requesterId,
      Money.of(dto.amount, NGN),
      (m) => this.ledgerService.getBalanceAndPendingFunding(m, requesterId),
    );

    const requester = await this.usersService.findById(requesterId);
    let payer: CounterpartyUser;
    try {
      payer = await this.usersService.findById(dto.payerUserId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new PayerNotFoundException();
      }
      throw error;
    }

    const now = new Date();
    const { moneyRequest, fromFollowed } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        if (
          await this.socialService.lockPairAndCheckBlock(
            manager,
            requesterId,
            dto.payerUserId,
          )
        ) {
          throw new RecipientUnableToReceiveException();
        }

        const outstanding = await this.countEffectivelyPending(
          manager,
          requesterId,
          dto.payerUserId,
          now,
        );
        if (outstanding >= this.config.moneyRequests.maxPendingPerPair) {
          throw new MoneyRequestPairCapExceededException(
            this.config.moneyRequests.maxPendingPerPair,
          );
        }

        const expiresAt = new Date(
          now.getTime() +
            this.config.moneyRequests.expiryDays * 24 * 60 * 60 * 1000,
        );
        const repo = manager.getRepository(MoneyRequest);
        const created = repo.create({
          requesterUserId: requesterId,
          payerUserId: dto.payerUserId,
          amount: BigInt(dto.amount),
          currency: NGN,
          note: dto.note ?? null,
          status: 'pending',
          expiresAt,
          transactionId: null,
        });
        const followed = await this.socialService.isFollowing(
          payer.id,
          requester.id,
        );
        await repo.save(created);
        return { moneyRequest: created, fromFollowed: followed };
      },
    );

    await this.publishCreatedEvent(
      moneyRequest,
      requester,
      payer,
      fromFollowed,
    );

    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  async listIncoming(
    payerId: string,
    pagination: MoneyRequestListPagination,
    bucket?: IncomingBucket,
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    const [hiddenPendingFrom, followedIds] = await Promise.all([
      this.socialService.getBlockedUserIds(payerId),
      bucket ? this.socialService.getFollowedUserIds(payerId) : [],
    ]);
    if (bucket === 'following' && followedIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    return this.list(
      'payerUserId',
      payerId,
      pagination,
      (mr) => mr.requesterUserId,
      {
        hiddenPendingFrom,
        bucket: bucket ? { kind: bucket, followedIds } : undefined,
      },
    );
  }

  async listOutgoing(
    requesterId: string,
    pagination: MoneyRequestListPagination,
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    return this.list(
      'requesterUserId',
      requesterId,
      pagination,
      (mr) => mr.payerUserId,
    );
  }

  // Requester only, and only while effectively pending — scoped in the
  // query itself (id + requesterUserId), so a wrong owner or an
  // already-resolved/expired request is indistinguishable from "doesn't
  // exist" (same IDOR discipline as notifications' markRead). The row is
  // locked and re-checked so a payment committing in between can't be
  // overwritten. No notification — cancel is excluded from the catalog by
  // design.
  async cancelRequest(
    requesterId: string,
    id: string,
  ): Promise<MoneyRequestResponseDto> {
    const now = new Date();
    const moneyRequest = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockPendingRequest(
          manager,
          id,
          'requesterUserId',
          requesterId,
          now,
        );
        locked.status = 'cancelled';
        return manager.getRepository(MoneyRequest).save(locked);
      },
    );

    await this.publishCancelledEvent(moneyRequest);

    const payer = await this.usersService.findById(moneyRequest.payerUserId);
    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  // Payer only, and only while effectively pending — same scoping and
  // locking as cancelRequest above. Notifies the requester.
  async declineRequest(
    payerId: string,
    id: string,
  ): Promise<MoneyRequestResponseDto> {
    const now = new Date();
    const moneyRequest = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockPendingRequest(
          manager,
          id,
          'payerUserId',
          payerId,
          now,
        );
        locked.status = 'declined';
        return manager.getRepository(MoneyRequest).save(locked);
      },
    );

    const [requester, payer] = await Promise.all([
      this.usersService.findById(moneyRequest.requesterUserId),
      this.usersService.findById(moneyRequest.payerUserId),
    ]);
    await this.publishDeclinedEvent(moneyRequest, requester, payer);

    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  // Paying a request is a P2P transfer with a moneyRequestId attached
  // (ADR-0012) — the request moving to `paid` and the transfer posting must
  // never disagree, so both writes happen inside the one transaction opened
  // here, via TransfersService.finalizeTransfer's manager-accepting form.
  //
  // The request row is locked (`pessimistic_write`) before any payability
  // decision is made, and the idempotency replay check runs before the
  // pending/expiry gate — a reference-based replay check alone doesn't stop
  // two concurrent pay attempts that use two *different* references, since
  // ADR-0010's idempotency is scoped per reference, not per request. The
  // lock is what makes that race safe: a second concurrent attempt blocks
  // here until the first commits, then observes `status = 'paid'` and is
  // rejected by the pending/expiry gate below — never a second successful
  // post. Checking for a replay ahead of that gate is what lets a genuine
  // retry of an already-paid request still return the original result
  // instead of "not payable".
  async payRequest(
    payerId: string,
    id: string,
    dto: PayMoneyRequestDto,
  ): Promise<MoneyRequestResponseDto> {
    const outcome = await runInTransaction(this.dataSource, async (manager) => {
      const moneyRequest = await manager
        .getRepository(MoneyRequest)
        .createQueryBuilder('moneyRequest')
        .where('moneyRequest.id = :id', { id })
        .andWhere('moneyRequest.payerUserId = :payerId', { payerId })
        .setLock('pessimistic_write')
        .getOne();
      if (!moneyRequest) {
        throw new MoneyRequestNotFoundException();
      }

      const details = {
        note: moneyRequest.note || null,
        visibility: dto.visibility,
      };
      const prepared = await this.transfersService.prepareTransfer(
        payerId,
        moneyRequest.requesterUserId,
        Number(moneyRequest.amount),
      );

      const replayResult = await this.transfersService.checkTransferReplay(
        payerId,
        prepared,
        dto.reference,
        details,
      );
      if (replayResult) {
        // checkTransferReplay's fingerprint (amount/currency/counterparty)
        // can't tell "paying request A" apart from "paying request B" when
        // both happen to be for the same amount to the same requester — it
        // only proves *some* prior transfer matches this reference, not
        // that it was this specific request's payment. Compare against
        // this row's own transactionId to be sure: if it doesn't match,
        // the reference collides with something unrelated to this request
        // (another request, or a plain transfer) and must not be treated
        // as if this request were paid.
        if (moneyRequest.transactionId === replayResult.transactionId) {
          return {
            moneyRequest,
            result: replayResult,
            replayed: true,
            sender: prepared.sender,
          };
        }
        throw new ConflictException(
          'This reference has already been used for a different transfer.',
        );
      }

      if (!isEffectivelyPending(moneyRequest, new Date())) {
        throw new MoneyRequestNotPayableException();
      }

      const { result } = await this.transfersService.finalizeTransfer(
        payerId,
        prepared,
        dto.reference,
        dto.pin,
        details,
        manager,
      );

      moneyRequest.status = 'paid';
      moneyRequest.transactionId = result.transactionId;
      await manager.getRepository(MoneyRequest).save(moneyRequest);

      return { moneyRequest, result, replayed: false, sender: prepared.sender };
    });

    const requester = await this.usersService.findById(
      outcome.moneyRequest.requesterUserId,
    );
    if (!outcome.replayed) {
      await this.publishPaidEvent(
        outcome.moneyRequest,
        requester,
        outcome.sender,
      );
    }

    return toMoneyRequestResponse(
      outcome.moneyRequest,
      toIdentitySummary(requester),
      new Date(),
    );
  }

  private async lockPendingRequest(
    manager: EntityManager,
    id: string,
    ownerField: 'requesterUserId' | 'payerUserId',
    ownerId: string,
    now: Date,
  ): Promise<MoneyRequest> {
    const moneyRequest = await manager
      .getRepository(MoneyRequest)
      .createQueryBuilder('moneyRequest')
      .where('moneyRequest.id = :id', { id })
      .andWhere(`moneyRequest.${ownerField} = :ownerId`, { ownerId })
      .setLock('pessimistic_write')
      .getOne();
    if (!moneyRequest || !isEffectivelyPending(moneyRequest, now)) {
      throw new MoneyRequestNotFoundException();
    }
    return moneyRequest;
  }

  private async countEffectivelyPending(
    manager: EntityManager,
    requesterId: string,
    payerId: string,
    now: Date,
  ): Promise<number> {
    const qb = applyEffectivelyPending(
      manager
        .getRepository(MoneyRequest)
        .createQueryBuilder('moneyRequest')
        .where('moneyRequest.requesterUserId = :requesterId', { requesterId })
        .andWhere('moneyRequest.payerUserId = :payerId', { payerId }),
      'moneyRequest',
      now,
    );
    return qb.getCount();
  }

  private async list(
    scopeField: 'payerUserId' | 'requesterUserId',
    userId: string,
    pagination: MoneyRequestListPagination,
    counterpartyIdOf: (moneyRequest: MoneyRequest) => string,
    { hiddenPendingFrom, bucket }: RequesterFilter = { hiddenPendingFrom: [] },
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;

    const query = this.moneyRequests
      .createQueryBuilder('moneyRequest')
      // Same reasoning as NotificationService.listNotifications: compare on
      // Postgres's own text form of created_at, not the millisecond-precision
      // JS Date, so rows sharing a millisecond never get silently skipped
      // at the page boundary.
      .addSelect('"moneyRequest"."created_at"::text', 'raw_created_at')
      .where(`moneyRequest.${scopeField} = :userId`, { userId })
      .orderBy('moneyRequest.createdAt', 'DESC')
      .addOrderBy('moneyRequest.id', 'DESC')
      .take(pagination.limit + 1);

    if (hiddenPendingFrom.length > 0) {
      query.andWhere(
        "NOT (moneyRequest.status = 'pending' AND moneyRequest.requesterUserId = ANY(:hiddenPendingFrom::uuid[]))",
        { hiddenPendingFrom },
      );
    }

    if (bucket?.kind === 'following') {
      query.andWhere(
        'moneyRequest.requesterUserId = ANY(:followedIds::uuid[])',
        {
          followedIds: bucket.followedIds,
        },
      );
    } else if (bucket?.kind === 'others' && bucket.followedIds.length > 0) {
      query.andWhere(
        'moneyRequest.requesterUserId <> ALL(:followedIds::uuid[])',
        {
          followedIds: bucket.followedIds,
        },
      );
    }

    if (cursor) {
      query.andWhere(
        '(moneyRequest.createdAt, moneyRequest.id) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > pagination.limit;
    const page = hasMore ? entities.slice(0, pagination.limit) : entities;
    const lastRaw = hasMore ? raw[pagination.limit - 1] : raw[raw.length - 1];

    const counterpartyIds = [...new Set(page.map(counterpartyIdOf))];
    const counterparties = await this.usersService.findByIds(counterpartyIds);
    const counterpartyById = new Map(counterparties.map((u) => [u.id, u]));
    const now = new Date();

    return {
      items: page.map((moneyRequest) => {
        const counterparty = counterpartyById.get(
          counterpartyIdOf(moneyRequest),
        );
        if (!counterparty) {
          throw new Error(
            `MoneyRequestsService.list: counterparty ${counterpartyIdOf(moneyRequest)} not found for money request ${moneyRequest.id}`,
          );
        }
        return toMoneyRequestResponse(
          moneyRequest,
          toIdentitySummary(counterparty),
          now,
        );
      }),
      nextCursor:
        hasMore && lastRaw
          ? encodeCreatedAtIdCursor({
              createdAt: lastRaw.raw_created_at,
              id: page[page.length - 1].id,
            })
          : null,
    };
  }

  private async publishCreatedEvent(
    moneyRequest: MoneyRequest,
    requester: CounterpartyUser,
    payer: CounterpartyUser,
    fromFollowed: boolean,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestCreatedEventPayload>({
        name: MONEY_REQUEST_CREATED_EVENT,
        payload: {
          userId: payer.id,
          email: payer.email,
          requesterUserId: requester.id,
          counterpartyUsername: requester.username,
          amount: Money.of(
            moneyRequest.amount,
            moneyRequest.currency,
          ).toDecimalString(),
          currency: moneyRequest.currency,
          note: moneyRequest.note,
          moneyRequestId: moneyRequest.id,
          fromFollowed,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishCreatedEvent: money request "${moneyRequest.id}" created successfully, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishCancelledEvent(
    moneyRequest: MoneyRequest,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestCancelledEventPayload>({
        name: MONEY_REQUEST_CANCELLED_EVENT,
        payload: {
          moneyRequestId: moneyRequest.id,
          requesterUserId: moneyRequest.requesterUserId,
          payerUserId: moneyRequest.payerUserId,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishCancelledEvent: money request "${moneyRequest.id}" cancelled successfully, but publishing the event failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishDeclinedEvent(
    moneyRequest: MoneyRequest,
    requester: CounterpartyUser,
    payer: CounterpartyUser,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestDeclinedEventPayload>({
        name: MONEY_REQUEST_DECLINED_EVENT,
        payload: {
          userId: requester.id,
          email: requester.email,
          counterpartyUsername: payer.username,
          amount: Money.of(
            moneyRequest.amount,
            moneyRequest.currency,
          ).toDecimalString(),
          currency: moneyRequest.currency,
          moneyRequestId: moneyRequest.id,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishDeclinedEvent: money request "${moneyRequest.id}" declined successfully, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  // A distinct notification type rather than reusing transfer_received —
  // the requester should connect this payment to *their specific request*
  // (amount, note) rather than receiving an undifferentiated "someone sent
  // you money", same as money_request_created/declined carry their own
  // context instead of a generic transfer notification. Only the requester
  // is notified here, matching #25's acceptance criteria; the payer gets no
  // separate transfer_sent, since this is the flow they themselves just
  // completed.
  private async publishPaidEvent(
    moneyRequest: MoneyRequest,
    requester: CounterpartyUser,
    payer: CounterpartyUser,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestPaidEventPayload>({
        name: MONEY_REQUEST_PAID_EVENT,
        payload: {
          userId: requester.id,
          email: requester.email,
          counterpartyUsername: payer.username,
          amount: Money.of(
            moneyRequest.amount,
            moneyRequest.currency,
          ).toDecimalString(),
          currency: moneyRequest.currency,
          note: moneyRequest.note,
          moneyRequestId: moneyRequest.id,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishPaidEvent: money request "${moneyRequest.id}" paid successfully, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
