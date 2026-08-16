import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, WhereExpressionBuilder } from 'typeorm';
import { EntityNotFoundError } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { UsersService } from '../users/users.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import {
  MONEY_REQUEST_CREATED_EVENT,
  MONEY_REQUEST_DECLINED_EVENT,
  MoneyRequestCreatedEventPayload,
  MoneyRequestDeclinedEventPayload,
} from '../../shared/events/domain-events';
import { Money } from '../../shared/primitives/money';
import { toIdentitySummary } from '../../common/dto/identity-summary.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { MoneyRequest } from './entities/money-request.entity';
import { CreateMoneyRequestDto } from './dto/create-money-request.dto';
import {
  MoneyRequestResponseDto,
  toMoneyRequestResponse,
} from './dto/money-request-response.dto';
import {
  MoneyRequestAmountTooLargeException,
  MoneyRequestAmountTooSmallException,
  MoneyRequestNotFoundException,
  MoneyRequestPairCapExceededException,
  PayerNotFoundException,
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
    @InjectRepository(MoneyRequest)
    private readonly moneyRequests: Repository<MoneyRequest>,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createRequest(
    requesterId: string,
    dto: CreateMoneyRequestDto,
  ): Promise<MoneyRequestResponseDto> {
    const { minAmount, maxAmount } = this.config.transfers;
    if (dto.amount < minAmount) {
      throw new MoneyRequestAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (dto.amount > maxAmount) {
      throw new MoneyRequestAmountTooLargeException(
        Money.of(maxAmount, NGN).toDecimalString(),
      );
    }
    if (dto.payerUserId === requesterId) {
      throw new SelfMoneyRequestException();
    }

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
    const outstanding = await this.countEffectivelyPending(
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
    const moneyRequest = this.moneyRequests.create({
      requesterUserId: requesterId,
      payerUserId: dto.payerUserId,
      amount: BigInt(dto.amount),
      currency: NGN,
      note: dto.note ?? null,
      status: 'pending',
      expiresAt,
      transactionId: null,
    });
    await this.moneyRequests.save(moneyRequest);

    await this.publishCreatedEvent(moneyRequest, requester, payer);

    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  async listIncoming(
    payerId: string,
    pagination: MoneyRequestListPagination,
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    return this.list(
      'payerUserId',
      payerId,
      pagination,
      (mr) => mr.requesterUserId,
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
  // query itself (id + requesterUserId + applyEffectivelyPending), so a
  // wrong owner or an already-resolved/expired request is indistinguishable
  // from "doesn't exist" (same IDOR discipline as notifications' markRead).
  // No notification — cancel is excluded from the catalog by design.
  async cancelRequest(
    requesterId: string,
    id: string,
  ): Promise<MoneyRequestResponseDto> {
    const now = new Date();
    const qb = applyEffectivelyPending(
      this.moneyRequests
        .createQueryBuilder('moneyRequest')
        .where('moneyRequest.id = :id', { id })
        .andWhere('moneyRequest.requesterUserId = :requesterId', {
          requesterId,
        }),
      'moneyRequest',
      now,
    );
    const moneyRequest = await qb.getOne();
    if (!moneyRequest) {
      throw new MoneyRequestNotFoundException();
    }

    moneyRequest.status = 'cancelled';
    await this.moneyRequests.save(moneyRequest);

    const payer = await this.usersService.findById(moneyRequest.payerUserId);
    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  // Payer only, and only while effectively pending — same scoping
  // discipline as cancelRequest above. Notifies the requester.
  async declineRequest(
    payerId: string,
    id: string,
  ): Promise<MoneyRequestResponseDto> {
    const now = new Date();
    const qb = applyEffectivelyPending(
      this.moneyRequests
        .createQueryBuilder('moneyRequest')
        .where('moneyRequest.id = :id', { id })
        .andWhere('moneyRequest.payerUserId = :payerId', { payerId }),
      'moneyRequest',
      now,
    );
    const moneyRequest = await qb.getOne();
    if (!moneyRequest) {
      throw new MoneyRequestNotFoundException();
    }

    moneyRequest.status = 'declined';
    await this.moneyRequests.save(moneyRequest);

    const [requester, payer] = await Promise.all([
      this.usersService.findById(moneyRequest.requesterUserId),
      this.usersService.findById(moneyRequest.payerUserId),
    ]);
    await this.publishDeclinedEvent(moneyRequest, requester, payer);

    return toMoneyRequestResponse(moneyRequest, toIdentitySummary(payer), now);
  }

  private async countEffectivelyPending(
    requesterId: string,
    payerId: string,
    now: Date,
  ): Promise<number> {
    const qb = applyEffectivelyPending(
      this.moneyRequests
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
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestCreatedEventPayload>({
        name: MONEY_REQUEST_CREATED_EVENT,
        payload: {
          userId: payer.id,
          email: payer.email,
          counterpartyUsername: requester.username,
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
        `publishCreatedEvent: money request "${moneyRequest.id}" created successfully, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
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
}
