import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LedgerService, PostChargebackResult } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Money } from '../../shared/primitives/money';
import {
  ACCOUNT_FROZEN_EVENT,
  AccountFrozenEventPayload,
  CHARGEBACK_RECEIVED_EVENT,
  ChargebackReceivedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { Dispute } from './entities/dispute.entity';
import { RecordChargebackDto } from './dto/record-chargeback.dto';
import {
  RecordChargebackResponseDto,
  toRecordChargebackResponse,
} from './dto/record-chargeback-response.dto';
import {
  ChargebackAmountExceedsRemainingException,
  DuplicateDisputeReferenceException,
  OriginalTransactionNotDisputableException,
  OriginalTransactionNotFoundException,
} from './internal/errors';

// A funding transaction is chargebackable while it still represents money
// that landed and hasn't already been fully unwound — `completed` (never
// charged back before) and `disputed` (already partially charged back, a
// further partial chargeback is allowed per §4.2) are the only two.
const CHARGEBACKABLE_STATUSES = new Set(['completed', 'disputed']);

/**
 * The one exported surface of the disputes module — see
 * docs/architecture.md §10 and ADR-0016. Reaches `ledger` and `users` only
 * through their exported services, never `transfers`/`withdrawals`/any
 * peripheral module.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
  ) {}

  // Issue #34. Admin-triggered (InternalSecretGuard, no AdminUser model yet
  // — ADR-0016): an ops person submits what the bank clawed back, this
  // posts the compensating transaction, freezes the account if it goes
  // negative, and notifies the user.
  async recordChargeback(
    dto: RecordChargebackDto,
  ): Promise<RecordChargebackResponseDto> {
    // Pre-check, not the sole guard — the unique constraint on
    // dispute_reference is the real race-free boundary (caught below), same
    // "insert and catch" reasoning as mapUsersUniqueViolation. This only
    // short-circuits the common case (a genuinely repeated notice) before
    // doing any posting work.
    const existing = await this.disputeRepo.findOneBy({
      disputeReference: dto.disputeReference,
    });
    if (existing) {
      throw new DuplicateDisputeReferenceException();
    }

    const original =
      await this.ledgerService.findFundingTransactionForChargeback(
        dto.originalTransactionReference,
      );
    if (!original) {
      throw new OriginalTransactionNotFoundException();
    }
    if (!CHARGEBACKABLE_STATUSES.has(original.status)) {
      throw new OriginalTransactionNotDisputableException();
    }

    const currency = original.amount.currency;
    const requested = Money.of(dto.amount, currency);
    const chargedBackSoFar = await this.ledgerService.getChargedBackAmount(
      original.id,
      currency,
    );
    const remaining = original.amount.subtract(chargedBackSoFar);
    if (requested.greaterThan(remaining)) {
      throw new ChargebackAmountExceedsRemainingException(
        remaining.toDecimalString(),
      );
    }

    let posted: PostChargebackResult;
    try {
      posted = await this.ledgerService.postChargeback({
        walletId: original.recipientWalletId,
        amount: requested,
        reference: dto.disputeReference,
        reversesTransactionId: original.id,
      });
    } catch (error) {
      // The chargeback transaction's own `reference` is dispute_reference
      // (ChargebackTransactionMetadata) — a concurrent duplicate submission
      // that raced past the pre-check above collides here instead.
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        throw new DuplicateDisputeReferenceException();
      }
      throw error;
    }

    // §4.2/ADR-0016: strictly negative, not <= 0 — a chargeback that
    // exactly zeroes the balance leaves nothing owed.
    const accountFrozen = posted.newWalletBalance.isNegative();
    if (accountFrozen) {
      await this.usersService.freeze(posted.userId);
    }

    let dispute: Dispute;
    try {
      dispute = await this.disputeRepo.save(
        this.disputeRepo.create({
          chargebackTransactionId: posted.transactionId,
          disputeReference: dto.disputeReference,
          status: 'open',
          amount: requested.amount,
          currency,
          resolvedAt: null,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_disputes_dispute_reference')) {
        throw new DuplicateDisputeReferenceException();
      }
      throw error;
    }

    const user = await this.usersService.findById(posted.userId);
    await this.publishChargebackReceivedEvent(
      posted,
      user,
      dto.disputeReference,
    );
    if (accountFrozen) {
      await this.publishAccountFrozenEvent(posted.userId, user.email);
    }

    return toRecordChargebackResponse(dispute, accountFrozen);
  }

  private async publishChargebackReceivedEvent(
    posted: PostChargebackResult,
    user: { email: string },
    disputeReference: string,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, ChargebackReceivedEventPayload>({
        name: CHARGEBACK_RECEIVED_EVENT,
        payload: {
          userId: posted.userId,
          email: user.email,
          amount: posted.amount.toDecimalString(),
          currency: posted.amount.currency,
          disputeReference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishChargebackReceivedEvent: chargeback posted successfully (reference "${disputeReference}"), but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishAccountFrozenEvent(
    userId: string,
    email: string,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, AccountFrozenEventPayload>({
        name: ACCOUNT_FROZEN_EVENT,
        payload: {
          userId,
          email,
          reason: 'A chargeback left your account balance negative.',
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishAccountFrozenEvent: account frozen successfully for user "${userId}", but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
