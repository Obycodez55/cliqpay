import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
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
  isUniqueViolation,
} from './internal/errors';

const NGN = 'NGN'; // Transfers are NGN-only for now — see docs/architecture.md §6 Phase 3.

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
    const { minAmount, maxAmount, platformFee } = this.config.transfers;
    if (dto.amount < minAmount) {
      throw new TransferAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (dto.amount > maxAmount) {
      throw new TransferAmountTooLargeException(
        Money.of(maxAmount, NGN).toDecimalString(),
      );
    }
    if (dto.recipientUserId === senderId) {
      throw new SelfTransferException();
    }

    const sender = await this.usersService.findById(senderId);
    if (!sender.emailVerifiedAt) {
      throw new SenderEmailNotVerifiedException();
    }

    let recipientWallet: Awaited<ReturnType<LedgerService['getUserWallet']>>;
    try {
      recipientWallet = await this.ledgerService.getUserWallet(
        dto.recipientUserId,
      );
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

    const amount = Money.of(dto.amount, NGN);
    // Only the fields that define the operation (ADR-0010) — the platform
    // fee is config-derived, never client-supplied, so it isn't part of the
    // fingerprint.
    const fingerprint = {
      amount: amount.amount,
      currency: NGN,
      counterpartyWalletId: recipientWallet.id,
    };

    const replay = await this.ledgerService.checkIdempotentReplay(
      dto.reference,
      senderId,
      fingerprint,
    );
    const replayResponse = resolveTransferReplay(replay, dto.recipientUserId);
    if (replayResponse) {
      return replayResponse;
    }

    // PIN checked only after a replay match would have short-circuited
    // above — a retried, already-successful send shouldn't demand the PIN
    // again, mirroring funding's checkoutUrl replay.
    await this.authService.verifyTransactionPin(senderId, dto.pin);

    const fee = Money.of(platformFee, NGN);
    let result: PostTransferResult;
    try {
      result = await this.ledgerService.postTransfer({
        reference: dto.reference,
        senderWalletId: senderWallet.id,
        recipientWalletId: recipientWallet.id,
        amount,
        platformFee: fee,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.ledgerService.checkIdempotentReplay(
          dto.reference,
          senderId,
          fingerprint,
        );
        const racedResponse = resolveTransferReplay(raced, dto.recipientUserId);
        if (racedResponse) {
          return racedResponse;
        }
      }
      throw error;
    }

    await this.publishTransferEvents(result, sender, dto.recipientUserId);

    return {
      reference: result.reference,
      amount: result.amount.toJSON(),
      fee: result.platformFee.toJSON(),
      recipientUserId: dto.recipientUserId,
      createdAt: result.createdAt.toISOString(),
    };
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
function resolveTransferReplay(
  replay: IdempotentReplay,
  recipientUserId: string,
): SendTransferResponseDto | null {
  switch (replay.outcome) {
    case 'match':
      return toSendTransferResponse(
        {
          reference: replay.transaction.reference,
          amount: replay.transaction.amount,
          currency: replay.transaction.currency,
          metadata: replay.transaction.metadata as unknown as Record<
            string,
            unknown
          >,
          createdAt: replay.transaction.createdAt,
        },
        recipientUserId,
      );
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

// Structural, not the `Transaction` entity type — transfers reaches ledger
// only through LedgerService's exported surface (docs/architecture.md §10),
// same convention as payments.service.ts's toFundWalletResponse.
function toSendTransferResponse(
  transaction: {
    reference: string;
    amount: bigint;
    currency: string;
    // Untyped, not the transfer-shaped metadata directly —
    // checkIdempotentReplay is shared across every transaction type, so its
    // shape can't promise transfer-shaped metadata here. In practice this
    // is only ever called with a transfer transaction, since
    // TransfersService is the only caller of checkIdempotentReplay with a
    // transfer reference.
    metadata: Record<string, unknown>;
    createdAt: Date;
  },
  recipientUserId: string,
): SendTransferResponseDto {
  const platformFee = transaction.metadata.platformFee as {
    amount: string;
    currency: string;
  };
  return {
    reference: transaction.reference,
    amount: Money.of(transaction.amount, transaction.currency).toJSON(),
    fee: Money.of(BigInt(platformFee.amount), platformFee.currency).toJSON(),
    recipientUserId,
    createdAt: transaction.createdAt.toISOString(),
  };
}
