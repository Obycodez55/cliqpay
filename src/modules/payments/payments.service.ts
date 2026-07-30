import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Money } from '../../shared/primitives/money';
import {
  FUNDING_COMPLETED_EVENT,
  FundingCompletedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';
import {
  InitiatePaymentResult,
  PAYMENT_PROVIDER_ADAPTER,
  PaymentProviderAdapter,
} from './adapters/payment-provider.interface';
import { isUniqueViolation } from './internal/errors';

const NGN = 'NGN'; // Funding is NGN-only for now — see issue #12.

// Ground truth: docs/adr/0007 — a real sandbox charge-verify response has
// this shape for the `data` field, and per Kora's docs the webhook payload
// mirrors it. Only the fields this handler actually reads.
interface KoraChargeWebhookPayload {
  event: string;
  data: {
    reference: string;
    status: string;
    amount: string;
    fee: number;
  };
}

/**
 * The one exported surface of the payments module — see
 * docs/architecture.md §10. No ledger entries are posted here — that's
 * issue #13, once a webhook actually confirms something succeeded. This
 * only gets as far as a `pending` `transactions` row and a checkout URL.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
    @Inject(PAYMENT_PROVIDER_ADAPTER)
    private readonly adapter: PaymentProviderAdapter,
  ) {}

  // Idempotent on `reference` (§3.4). The `transactions` row is inserted
  // *before* calling the provider, not after — the unique constraint on
  // `reference` then gates the provider call itself, so two concurrent
  // requests for the same `reference` (a client retrying after a timeout is
  // the realistic case, not a double-tap) can never both reach Kora. Only
  // whichever request wins the insert calls the provider; the loser either
  // gets the winner's completed checkoutUrl or, if the winner hasn't
  // finished yet, a 409 — never a second charge initialization.
  async fundWallet(
    userId: string,
    dto: FundWalletDto,
  ): Promise<FundWalletResponseDto> {
    const existing = await this.ledgerService.findTransactionByReference(
      dto.reference,
    );
    if (existing) {
      return toFundWalletResponse(existing);
    }

    const [user, wallet] = await Promise.all([
      this.usersService.findById(userId),
      this.ledgerService.getUserWallet(userId),
    ]);
    const amount = Money.of(dto.amount, NGN);

    try {
      await this.ledgerService.createPendingFundingTransaction({
        reference: dto.reference,
        provider: 'kora',
        providerReference: dto.reference,
        amount,
        recipientWalletId: wallet.id,
        metadata: { checkoutUrl: null },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.ledgerService.findTransactionByReference(
          dto.reference,
        );
        if (raced) {
          return toFundWalletResponse(raced);
        }
      }
      throw error;
    }

    let result: InitiatePaymentResult;
    try {
      result = await this.adapter.initiatePayment({
        reference: dto.reference,
        amount,
        customerEmail: user.email,
      });
    } catch (error) {
      await this.ledgerService.markFundingTransactionFailed(dto.reference);
      throw error;
    }

    await this.ledgerService.setFundingCheckoutUrl(
      dto.reference,
      result.checkoutUrl,
    );
    return { checkoutUrl: result.checkoutUrl };
  }

  // Signature verified against the raw bytes Kora actually signed (see
  // KoraAdapter.verifyWebhookSignature) — invalid signature never reaches
  // the ledger, never changes transaction status (ADR-0008, issue #13).
  // Everything past that point is provider-fact mapping only: this owns no
  // accounting knowledge, LedgerService.postFunding decides what these
  // facts post to.
  async handleFundingWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<void> {
    if (
      !signature ||
      !this.adapter.verifyWebhookSignature(rawBody, signature)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payload = JSON.parse(
      rawBody.toString('utf8'),
    ) as KoraChargeWebhookPayload;
    const { data } = payload;

    const netAmount = Money.fromDecimalString(data.amount, NGN);
    const providerFee = Money.fromDecimalString(String(data.fee), NGN);
    const providerStatus = data.status === 'success' ? 'success' : 'failed';

    const result = await this.ledgerService.postFunding({
      reference: data.reference,
      netAmount,
      providerFee,
      providerStatus,
    });
    if (!result) {
      // Duplicate delivery of an already-resolved transaction, or a
      // provider-reported failure — either way, nothing further to publish.
      return;
    }

    try {
      const user = await this.usersService.findById(result.userId);
      await this.eventBus.publish<string, FundingCompletedEventPayload>({
        name: FUNDING_COMPLETED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.netAmount.toDecimalString(),
          currency: result.netAmount.currency,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `handleFundingWebhook: funding for reference "${data.reference}" posted successfully, but publishing the completion notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

// Structurally typed rather than importing ledger's `Transaction` entity —
// payments reaches ledger only through LedgerService's exported methods,
// never its internals (docs/architecture.md §10, ADR-0008), and this is all
// the shape this function actually needs.
interface FundingLookupResult {
  metadata: { checkoutUrl: string | null };
}

// A transaction found by reference (the fast pre-check, or the race-loser
// re-fetch) has a checkout URL once the request that created it has
// actually heard back from the provider — until then, this reports the
// honest "still in progress" state instead of fabricating a URL.
function toFundWalletResponse(
  transaction: FundingLookupResult,
): FundWalletResponseDto {
  if (!transaction.metadata.checkoutUrl) {
    throw new ConflictException(
      'A funding request for this reference is already being processed — retry shortly.',
    );
  }
  return { checkoutUrl: transaction.metadata.checkoutUrl };
}
