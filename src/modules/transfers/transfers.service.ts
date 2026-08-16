import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityManager, EntityNotFoundError } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  IdempotentReplay,
  LedgerService,
  PostTransferResult,
} from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { Money } from '../../shared/primitives/money';
import {
  TRANSFER_RECEIVED_EVENT,
  TRANSFER_SENT_EVENT,
  TransferReceivedEventPayload,
  TransferSentEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { SendTransferDto } from './dto/send-transfer.dto';
import { SendTransferResponseDto } from './dto/send-transfer-response.dto';
import {
  RecipientWalletNotFoundException,
  SelfTransferException,
  SenderEmailNotVerifiedException,
  TransferAmountTooLargeException,
  TransferAmountTooSmallException,
  UnsupportedTransferCurrencyException,
} from './internal/errors';
import { isUniqueViolation } from '../../database/postgres-errors.util';

const NGN = 'NGN'; // Transfers are NGN-only for now — see docs/architecture.md §6 Phase 3.

// Structural, not the `User`/`Account` entity types — transfers reaches
// users/ledger only through their exported service surfaces
// (docs/architecture.md §10).
type TransferSender = Awaited<ReturnType<UsersService['findById']>>;
type TransferWallet = Awaited<ReturnType<LedgerService['getUserWallet']>>;

export interface PreparedTransfer {
  sender: TransferSender;
  senderWallet: TransferWallet;
  recipientWallet: TransferWallet;
  amount: Money;
}

export interface ExecuteTransferParams {
  recipientUserId: string;
  amount: number; // minor units
  reference: string;
  pin: string;
}

export interface ExecuteTransferOutcome {
  result: PostTransferResult;
  // False only for the one call that actually posted new ledger entries —
  // every other outcome (idempotent replay, raced duplicate insert) must
  // not re-publish notifications for an event that already fired once.
  replayed: boolean;
  sender: TransferSender;
}

/**
 * The one exported surface of the transfers module — see
 * docs/architecture.md §10 and ADR-0011. Owns eligibility, PIN
 * verification, and idempotency; hands ledger the facts and lets it decide
 * what they post to.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sendMoney(
    senderId: string,
    dto: SendTransferDto,
  ): Promise<SendTransferResponseDto> {
    const outcome = await this.executeTransfer(senderId, {
      recipientUserId: dto.recipientUserId,
      amount: dto.amount,
      reference: dto.reference,
      pin: dto.pin,
    });

    if (!outcome.replayed) {
      await this.publishTransferEvents(
        outcome.result,
        outcome.sender,
        dto.recipientUserId,
      );
    }

    return {
      reference: outcome.result.reference,
      amount: outcome.result.amount.toJSON(),
      fee: outcome.result.platformFee.toJSON(),
      recipientUserId: dto.recipientUserId,
      createdAt: outcome.result.createdAt.toISOString(),
    };
  }

  // Bounds/self-transfer/verified-email/wallet-resolution — every rule that
  // doesn't depend on idempotency or the PIN, shared by sendMoney and
  // MoneyRequestsService.payRequest (same-module peer, ADR-0011) so the two
  // money-movement entry points can't drift on what "eligible to send"
  // means.
  async prepareTransfer(
    senderId: string,
    recipientUserId: string,
    amountMinor: number,
  ): Promise<PreparedTransfer> {
    const { minAmount, maxAmount } = this.config.transfers;
    if (amountMinor < minAmount) {
      throw new TransferAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (amountMinor > maxAmount) {
      throw new TransferAmountTooLargeException(
        Money.of(maxAmount, NGN).toDecimalString(),
      );
    }
    if (recipientUserId === senderId) {
      throw new SelfTransferException();
    }

    const sender = await this.usersService.findById(senderId);
    if (!sender.emailVerifiedAt) {
      throw new SenderEmailNotVerifiedException();
    }

    let recipientWallet: TransferWallet;
    try {
      recipientWallet = await this.ledgerService.getUserWallet(recipientUserId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RecipientWalletNotFoundException();
      }
      throw error;
    }
    const senderWallet = await this.ledgerService.getUserWallet(senderId);

    // Currency is hardcoded below (no currency field on the DTO), so this
    // can't be reached through the real API today — defensive only, for the
    // day multi-currency wallets exist (Phase 10).
    if (senderWallet.currency !== NGN || recipientWallet.currency !== NGN) {
      throw new UnsupportedTransferCurrencyException();
    }

    return {
      sender,
      senderWallet,
      recipientWallet,
      amount: Money.of(amountMinor, NGN),
    };
  }

  // Whether `reference` already has a result for this sender+operation —
  // split out from finalizeTransfer below so a caller that needs to gate on
  // something else first (MoneyRequestsService.payRequest gates on the
  // request's own pending/expiry state) can check for a replay — which must
  // always win regardless of that other state, since it proves this exact
  // operation already completed — without paying for a PIN verification it
  // may not need.
  async checkTransferReplay(
    senderId: string,
    prepared: PreparedTransfer,
    reference: string,
  ): Promise<PostTransferResult | null> {
    // Only the fields that define the operation (ADR-0010) — the platform
    // fee is config-derived, never client-supplied, so it isn't part of the
    // fingerprint. `type` guards against a reference reused across a
    // different transaction type entirely (Phase 3 end-of-phase audit).
    const fingerprint = {
      type: 'p2p_transfer' as const,
      amount: prepared.amount.amount,
      currency: NGN,
      counterpartyWalletId: prepared.recipientWallet.id,
    };
    const replay = await this.ledgerService.checkIdempotentReplay(
      reference,
      senderId,
      fingerprint,
    );
    return resolveReplayAsPostResult(replay, prepared);
  }

  // PIN verification and posting — called only once a caller has confirmed
  // there is no replay and the operation is actually eligible to proceed.
  // `manager` lets a caller with its own open transaction (paying a money
  // request must post the transfer and flip the request's status
  // atomically) fold this posting into it, rather than defaulting to
  // postTransfer's own implicit transaction.
  async finalizeTransfer(
    senderId: string,
    prepared: PreparedTransfer,
    reference: string,
    pin: string,
    manager?: EntityManager,
  ): Promise<PostTransferResult> {
    await this.authService.verifyTransactionPin(senderId, pin);

    const fee = Money.of(this.config.transfers.platformFee, NGN);
    const postParams = {
      reference,
      senderWalletId: prepared.senderWallet.id,
      recipientWalletId: prepared.recipientWallet.id,
      amount: prepared.amount,
      platformFee: fee,
    };

    if (manager) {
      // A duplicate-reference race against *this same request* is
      // impossible on this path — the caller already holds a row lock (see
      // MoneyRequestsService.payRequest) that serializes concurrent
      // attempts before either reaches here. But that lock is per-request,
      // not per-reference: a client reusing this `reference` on a
      // *different* money request (or a plain sendMoney call) has no lock
      // relationship with this one, and would still hit
      // UQ_transactions_reference. Unlike the no-manager branch below, that
      // can't be recovered as a replay here — the failed insert has already
      // aborted this transaction at the Postgres level, so a further query
      // on `manager` (or letting the callback resolve "successfully" into a
      // commit of an aborted transaction) isn't safe. The caller already
      // ruled out a same-reference replay for this sender before reaching
      // here, so a collision now can only be a genuine clash with someone
      // else's transaction — map it to the same clean conflict the
      // no-manager path produces instead of a raw 500.
      try {
        return await this.ledgerService.postTransferWithinTransaction(
          manager,
          postParams,
        );
      } catch (error) {
        if (isUniqueViolation(error, 'UQ_transactions_reference')) {
          throw new ConflictException(
            'This reference has already been used for a different transfer.',
          );
        }
        throw error;
      }
    }

    try {
      return await this.ledgerService.postTransfer(postParams);
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.checkTransferReplay(
          senderId,
          prepared,
          reference,
        );
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  // The shared core of a plain P2P send — bounds/eligibility, the
  // idempotency replay check, then PIN verification and posting.
  // MoneyRequestsService.payRequest calls the three steps above directly
  // instead, since it needs to gate on the request's own pending/expiry
  // state in between the replay check and finalizeTransfer.
  async executeTransfer(
    senderId: string,
    params: ExecuteTransferParams,
    manager?: EntityManager,
  ): Promise<ExecuteTransferOutcome> {
    const prepared = await this.prepareTransfer(
      senderId,
      params.recipientUserId,
      params.amount,
    );

    const replayResult = await this.checkTransferReplay(
      senderId,
      prepared,
      params.reference,
    );
    if (replayResult) {
      return { result: replayResult, replayed: true, sender: prepared.sender };
    }

    // PIN checked only after a replay match would have short-circuited
    // above — a retried, already-successful send shouldn't demand the PIN
    // again, mirroring funding's checkoutUrl replay.
    const result = await this.finalizeTransfer(
      senderId,
      prepared,
      params.reference,
      params.pin,
      manager,
    );
    return { result, replayed: false, sender: prepared.sender };
  }

  private async publishTransferEvents(
    result: PostTransferResult,
    sender: { email: string; username: string },
    recipientUserId: string,
  ): Promise<void> {
    try {
      const recipient = await this.usersService.findById(recipientUserId);
      const occurredAt = new Date();
      await this.eventBus.publish<string, TransferSentEventPayload>({
        name: TRANSFER_SENT_EVENT,
        payload: {
          userId: result.senderUserId,
          email: sender.email,
          counterpartyUsername: recipient.username,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
        },
        occurredAt,
      });
      await this.eventBus.publish<string, TransferReceivedEventPayload>({
        name: TRANSFER_RECEIVED_EVENT,
        payload: {
          userId: result.recipientUserId,
          email: recipient.email,
          counterpartyUsername: sender.username,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
        },
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `publishTransferEvents: transfer posted successfully (reference "${result.reference}"), but publishing the notifications failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

// A reference belonging to another user must 409 with nothing about the
// other transaction attached (ADR-0010, defect 1). Returns null on 'none'
// so the caller falls through to actually posting the transfer.
function resolveReplayAsPostResult(
  replay: IdempotentReplay,
  prepared: PreparedTransfer,
): PostTransferResult | null {
  switch (replay.outcome) {
    case 'match': {
      const platformFee = replay.transaction.metadata as unknown as {
        platformFee: { amount: string; currency: string };
      };
      return {
        transactionId: replay.transaction.id,
        reference: replay.transaction.reference,
        senderUserId: prepared.senderWallet.userId!,
        recipientUserId: prepared.recipientWallet.userId!,
        amount: Money.of(
          replay.transaction.amount,
          replay.transaction.currency,
        ),
        platformFee: Money.of(
          BigInt(platformFee.platformFee.amount),
          platformFee.platformFee.currency,
        ),
        createdAt: replay.transaction.createdAt,
      };
    }
    case 'foreign':
      throw new ConflictException(
        'This reference has already been used for a different transfer.',
      );
    case 'diverged':
      throw new UnprocessableEntityException(
        'This reference was already used to send a different amount or to a different recipient — use a new reference.',
      );
    case 'none':
      return null;
  }
}
