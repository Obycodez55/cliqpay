import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ChargebackTransactionForWallet,
  FundingTransactionForChargeback,
  LedgerService,
  PostChargebackResult,
} from '../ledger/ledger.service';
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
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import {
  CollectionsEntryDto,
  toCollectionsEntry,
} from './dto/collections-response.dto';
import {
  ResolveDisputeResponseDto,
  toResolveDisputeResponse,
} from './dto/resolve-dispute-response.dto';
import {
  DisputeAlreadyResolvedException,
  DisputeNotFoundException,
  DisputeResolutionAmountMismatchException,
  DuplicateDisputeReferenceException,
  OriginalTransactionNotDisputableException,
  OriginalTransactionNotFoundException,
} from './internal/errors';

// A funding transaction is chargebackable while it still represents money
// that landed and hasn't already been fully unwound — `completed` (never
// charged back before) and `disputed` (already partially charged back, a
// further partial chargeback is allowed per §4.2) are the only two. Not
// racy against a concurrent chargeback: nothing ever moves a funding
// transaction's status backward out of this set once it's in it (only
// forward, completed -> disputed), so a plain unlocked read here can't miss
// a status that would have failed this check.
const CHARGEBACKABLE_STATUSES = new Set(['completed', 'disputed']);

interface ChargebackPosting {
  posted: PostChargebackResult;
  dispute: Dispute;
  accountFrozen: boolean;
}

/**
 * The one exported surface of the disputes module — see
 * docs/architecture.md §10 and ADR-0016. Reaches `ledger` and `users` only
 * through their exported services, never `transfers`/`withdrawals`/any
 * peripheral module. `@InjectDataSource` rather than `@InjectRepository` —
 * recordChargeback runs a multi-entity atomic write (ledger posting, the
 * freeze, and the `disputes` row all commit or roll back together), so this
 * needs the DataSource regardless (CLAUDE.md's repository-access rule).
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
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
    const existing = await this.dataSource
      .getRepository(Dispute)
      .findOneBy({ disputeReference: dto.disputeReference });
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

    // The amount-cap check itself is NOT done here — it's enforced inside
    // LedgerService.postChargeback, under the same lock it takes on the
    // original transaction row, so two concurrent partial chargebacks
    // against the same original can't both read a stale "remaining" figure
    // and both post (see that method's own doc comment).
    const { posted, dispute, accountFrozen } =
      await this.postChargebackAtomically(dto, original, requested, currency);

    // Fetched after the money movement/freeze/dispute-row write have all
    // committed — a failure here must not look like the whole operation
    // failed (a retry would just hit the dedupe path above and 409), so
    // it's logged and swallowed rather than thrown, same as the two
    // publish helpers below.
    let email: string | undefined;
    try {
      email = (await this.usersService.findById(posted.userId)).email;
    } catch (error) {
      this.logger.error(
        `recordChargeback: chargeback recorded successfully (dispute reference "${dto.disputeReference}"), but fetching the user's email for notifications failed (${(error as Error).message}) — notifications will not be sent`,
      );
    }

    if (email) {
      await this.publishChargebackReceivedEvent(
        posted,
        email,
        dto.disputeReference,
      );
      if (accountFrozen) {
        await this.publishAccountFrozenEvent(posted.userId, email);
      }
    }

    return toRecordChargebackResponse(dispute, accountFrozen);
  }

  // Folds the ledger posting, the freeze decision, and the `disputes` row
  // write into one DB transaction — same "commit or roll back together"
  // shape as MoneyRequestsService.payRequest folding
  // postTransferWithinTransaction and its own status flip into one
  // transaction. Without this, a failure between postChargeback committing
  // and the disputes row/freeze landing would leave money already moved
  // with no dispute row to resolve later (#36) and/or a wallet that should
  // be frozen but isn't.
  private async postChargebackAtomically(
    dto: RecordChargebackDto,
    original: FundingTransactionForChargeback,
    requested: Money,
    currency: string,
  ): Promise<ChargebackPosting> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const posted = await this.ledgerService.postChargebackWithinTransaction(
          manager,
          {
            walletId: original.recipientWalletId,
            amount: requested,
            reference: dto.disputeReference,
            reversesTransactionId: original.id,
          },
        );

        // §4.2/ADR-0016: strictly negative, not <= 0 — a chargeback that
        // exactly zeroes the balance leaves nothing owed.
        const accountFrozen = posted.newWalletBalance.isNegative();
        if (accountFrozen) {
          await this.usersService.freeze(manager, posted.userId);
        }

        const disputeRepo = manager.getRepository(Dispute);
        const dispute = await disputeRepo.save(
          disputeRepo.create({
            chargebackTransactionId: posted.transactionId,
            disputeReference: dto.disputeReference,
            status: 'open',
            amount: requested.amount,
            currency,
            resolvedAt: null,
          }),
        );

        return { posted, dispute, accountFrozen };
      });
    } catch (error) {
      // Two distinct unique constraints can be the one that actually fires
      // for a duplicate submission that raced past the pre-check in
      // recordChargeback: the chargeback transaction's own `reference` is
      // dispute_reference (ChargebackTransactionMetadata), so
      // UQ_transactions_reference collides first; UQ_disputes_dispute_reference
      // is the backstop if it somehow doesn't. Either way it's the same
      // user-facing outcome — a repeat notice, not re-posted.
      if (
        isUniqueViolation(error, 'UQ_transactions_reference') ||
        isUniqueViolation(error, 'UQ_disputes_dispute_reference')
      ) {
        throw new DuplicateDisputeReferenceException();
      }
      throw error;
    }
  }

  // Issue #37. No pagination/filtering in this phase (flat list, current
  // expected volume). `ledger` supplies the accounting facts (which
  // wallets are negative, which chargebacks hit them); this composes them
  // with each user's frozen status and the `disputes` rows those
  // chargebacks belong to. A wallet can have more than one contributing
  // chargeback (§4.2 partial chargebacks), so each entry lists all of
  // them rather than picking just the most recent — see
  // CollectionsEntryDto's own comment.
  async getCollections(): Promise<CollectionsEntryDto[]> {
    const wallets = await this.ledgerService.findNegativeBalanceWallets();
    if (wallets.length === 0) {
      return [];
    }

    const [chargebacks, users] = await Promise.all([
      this.ledgerService.findChargebackTransactionsForWallets(
        wallets.map((wallet) => wallet.accountId),
      ),
      this.usersService.findByIds(wallets.map((wallet) => wallet.userId)),
    ]);

    const disputesByChargebackId = await this.findDisputesByChargebackId(
      chargebacks.map((chargeback) => chargeback.transactionId),
    );
    const isFrozenByUserId = new Map(
      users.map((user) => [user.id, user.isFrozen]),
    );
    const chargebacksByWalletId = this.groupChargebacksByWalletId(chargebacks);

    return wallets.map((wallet) =>
      toCollectionsEntry(
        wallet,
        chargebacksByWalletId.get(wallet.accountId) ?? [],
        disputesByChargebackId,
        isFrozenByUserId.get(wallet.userId) ?? false,
      ),
    );
  }

  private groupChargebacksByWalletId(
    chargebacks: ChargebackTransactionForWallet[],
  ): Map<string, ChargebackTransactionForWallet[]> {
    const byWalletId = new Map<string, ChargebackTransactionForWallet[]>();
    for (const chargeback of chargebacks) {
      const existing = byWalletId.get(chargeback.walletId) ?? [];
      existing.push(chargeback);
      byWalletId.set(chargeback.walletId, existing);
    }
    return byWalletId;
  }

  private async findDisputesByChargebackId(
    chargebackTransactionIds: string[],
  ): Promise<Map<string, Dispute>> {
    if (chargebackTransactionIds.length === 0) {
      return new Map();
    }
    const disputes = await this.dataSource.getRepository(Dispute).find({
      where: { chargebackTransactionId: In(chargebackTransactionIds) },
    });
    return new Map(
      disputes.map((dispute) => [dispute.chargebackTransactionId, dispute]),
    );
  }

  private async publishChargebackReceivedEvent(
    posted: PostChargebackResult,
    email: string,
    disputeReference: string,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, ChargebackReceivedEventPayload>({
        name: CHARGEBACK_RECEIVED_EVENT,
        payload: {
          userId: posted.userId,
          email,
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

  // Issue #36. Admin-triggered close-out of a dispute recorded via
  // recordChargeback — the same internal guard, keyed on the dispute's own
  // dispute_reference rather than any ledger id. Locks the `disputes` row
  // for the whole operation: that lock is what makes a concurrent resolve
  // attempt on the *same* dispute serialize behind this one (the second
  // waits for this transaction to commit, then re-reads a status that's no
  // longer 'open' and rejects) — same "lock, validate, post" shape
  // postChargebackEntries uses for its own amount cap, just enforced here on
  // the disputes row instead of duplicated inside ledger.
  async resolveDispute(
    dto: ResolveDisputeDto,
  ): Promise<ResolveDisputeResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const disputeRepo = manager.getRepository(Dispute);
      const dispute = await disputeRepo
        .createQueryBuilder('dispute')
        .where('dispute.disputeReference = :reference', {
          reference: dto.disputeReference,
        })
        .setLock('pessimistic_write')
        .getOne();
      if (!dispute) {
        throw new DisputeNotFoundException();
      }
      if (dispute.status !== 'open') {
        throw new DisputeAlreadyResolvedException();
      }

      if (dto.outcome === 'upheld') {
        return this.resolveAsUpheld(manager, dispute);
      }

      // dto.amount is required by ResolveDisputeDto's own validation
      // whenever outcome is 'resolved' — never trusted on its own, checked
      // against the dispute's own recorded amount, the same value the
      // ledger posting below actually reverses.
      if (BigInt(dto.amount!) !== dispute.amount) {
        throw new DisputeResolutionAmountMismatchException(
          dispute.amount.toString(),
        );
      }
      return this.resolveInCliqpaysFavor(manager, dispute);
    });
  }

  private async resolveAsUpheld(
    manager: EntityManager,
    dispute: Dispute,
  ): Promise<ResolveDisputeResponseDto> {
    await this.ledgerService.upholdChargebackWithinTransaction(
      manager,
      dispute.chargebackTransactionId,
    );

    const disputeRepo = manager.getRepository(Dispute);
    await disputeRepo.update(
      { id: dispute.id },
      { status: 'upheld', resolvedAt: new Date() },
    );
    const resolved = await disputeRepo.findOneByOrFail({ id: dispute.id });

    return toResolveDisputeResponse(resolved, false);
  }

  private async resolveInCliqpaysFavor(
    manager: EntityManager,
    dispute: Dispute,
  ): Promise<ResolveDisputeResponseDto> {
    const posted =
      await this.ledgerService.postChargebackResolutionWithinTransaction(
        manager,
        {
          chargebackTransactionId: dispute.chargebackTransactionId,
          amount: Money.of(dispute.amount, dispute.currency),
        },
      );

    // §4.2/ADR-0016/issue #36: `>= 0`, unlike the freeze threshold's
    // strict `< 0` — a resolution that brings the balance back to exactly
    // zero leaves nothing owed, so the freeze lifts.
    const accountUnfrozen = !posted.newWalletBalance.isNegative();
    if (accountUnfrozen) {
      await this.usersService.unfreeze(manager, posted.userId);
    }

    const disputeRepo = manager.getRepository(Dispute);
    await disputeRepo.update(
      { id: dispute.id },
      { status: 'resolved', resolvedAt: new Date() },
    );
    const resolved = await disputeRepo.findOneByOrFail({ id: dispute.id });

    return toResolveDisputeResponse(resolved, accountUnfrozen);
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
