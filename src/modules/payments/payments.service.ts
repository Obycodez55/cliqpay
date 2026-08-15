import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Money } from '../../shared/primitives/money';
import {
  FUNDING_COMPLETED_EVENT,
  FundingCompletedEventPayload,
  RECONCILIATION_MISMATCH_EVENT,
  ReconciliationMismatchEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';
import {
  InitiatePaymentResult,
  PAYMENT_PROVIDER_ADAPTER,
  PaymentProviderAdapter,
  VerifyChargeResult,
} from './adapters/payment-provider.interface';
import { isUniqueViolation } from './internal/errors';
import { extractTopLevelJsonField } from './internal/raw-json';
import {
  IdempotentReplay,
  PostFundingFacts,
  PostFundingResult,
} from '../ledger/ledger.service';
import {
  ACTIVE_RECONCILIATION_PAIRS,
  ActiveReconciliationPair,
} from './internal/active-reconciliation-pairs';

const NGN = 'NGN'; // Funding is NGN-only for now — see issue #12.

const STALE_FUNDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// Ground truth: docs/adr/0007 — confirmed against a real webhook Kora
// delivered during the Phase 2 e2e pass, not just docs. Only the fields
// this handler actually reads. `amount`/`fee` are normalized to strings
// here — Kora sends both as raw JSON numbers (not the decimal strings the
// verify endpoint uses), so nothing downstream needs its own String()
// wrapping or needs to know the type differs by endpoint.
interface KoraChargeWebhookData {
  reference: string;
  status: string;
  amount: string;
  fee: string;
}

// A valid signature only proves Kora (or whoever holds the key) sent the
// bytes — it says nothing about whether "data" is shaped like a charge
// event. A malformed shape is a bad request (400), not a server bug (500);
// letting `data.reference`/`.status`/`.amount` reach a Money/DB call
// untyped risks an uncaught TypeError instead (see the Phase 2 audit, L4).
function validateWebhookData(parsed: unknown): KoraChargeWebhookData {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Malformed webhook payload');
  }
  const { reference, status, amount, fee } = parsed as Record<string, unknown>;
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    typeof status !== 'string' ||
    status.length === 0 ||
    (typeof amount !== 'string' && typeof amount !== 'number') ||
    (typeof fee !== 'string' && typeof fee !== 'number')
  ) {
    throw new BadRequestException('Malformed webhook payload');
  }
  return { reference, status, amount: String(amount), fee: String(fee) };
}

/**
 * The one exported surface of the payments module — see
 * docs/architecture.md §10. Never posts ledger entries directly — hands
 * provider facts to LedgerService.postFunding and lets ledger decide what
 * they post to (ADR-0008).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly reconciliationAlertEmail: string;

  constructor(
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
    @Inject(PAYMENT_PROVIDER_ADAPTER)
    private readonly adapter: PaymentProviderAdapter,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.reconciliationAlertEmail = config.payments.reconciliation.alertEmail;
  }

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
    const amount = Money.of(dto.amount, NGN);
    // Funding has no counterparty (it always credits the caller's own
    // wallet) — amount/currency are the only fields that define the
    // operation here, per ADR-0010.
    const fingerprint = { amount: amount.amount, currency: amount.currency };

    const replay = await this.ledgerService.checkIdempotentReplay(
      dto.reference,
      userId,
      fingerprint,
    );
    const replayResponse = resolveFundingReplay(replay);
    if (replayResponse) {
      return replayResponse;
    }

    const [user, wallet] = await Promise.all([
      this.usersService.findById(userId),
      this.ledgerService.getUserWallet(userId),
    ]);

    try {
      await this.ledgerService.createPendingFundingTransaction({
        reference: dto.reference,
        provider: 'kora',
        providerReference: dto.reference,
        amount,
        recipientWalletId: wallet.id,
        metadata: { checkoutUrl: null, grossAmount: null },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.ledgerService.checkIdempotentReplay(
          dto.reference,
          userId,
          fingerprint,
        );
        const racedResponse = resolveFundingReplay(raced);
        if (racedResponse) {
          return racedResponse;
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

    // Parsed from the *same* extracted "data" slice the signature was
    // computed over (KoraAdapter.verifyWebhookSignature uses the identical
    // extractTopLevelJsonField call internally) — not a fresh
    // JSON.parse(rawBody). A body with two top-level "data" keys would
    // otherwise let the signature verify against one and this act on the
    // other: extractTopLevelJsonField always resolves the first match,
    // native JSON.parse always keeps the last, and those two disagreeing is
    // exactly the gap that let a signature validate one payload while a
    // different one got posted.
    const rawData = extractTopLevelJsonField(rawBody, 'data');
    if (!rawData) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    // A signature can be valid over a "data" object shaped nothing like
    // what's expected (or invalid JSON entirely) — that's a malformed
    // request (400), not a server bug (500), and must not throw an
    // uncaught TypeError partway through processing.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook payload');
    }
    const data = validateWebhookData(parsed);

    // Matches KoraAdapter.verifyCharge's three-way mapping exactly: only
    // "success"/"failed" are terminal. Anything else (e.g. "processing") is
    // a charge still in flight — collapsing that into "failed" here would
    // permanently kill a transaction Kora later reports as successful,
    // since findStaleFundingTransactions only polls `status = 'pending'`
    // rows. Leave it pending; the poll job (#14) resolves it once Kora
    // reports a terminal outcome.
    if (data.status !== 'success' && data.status !== 'failed') {
      this.logger.debug(
        `handleFundingWebhook: non-terminal status "${data.status}" for reference "${data.reference}" — leaving pending`,
      );
      return;
    }
    const providerStatus = data.status;
    // Unused by postFunding for a `failed` outcome — see
    // LedgerService.postFunding's early return before any entries are
    // posted (same reasoning as PaymentsService.pollFundingTransaction).
    let netAmount = Money.zero(NGN);
    let providerFee = Money.zero(NGN);
    if (providerStatus === 'success') {
      try {
        netAmount = Money.fromDecimalString(data.amount, NGN);
        providerFee = Money.fromDecimalString(data.fee, NGN);
      } catch (error) {
        throw new BadRequestException(
          `Malformed webhook payload: ${(error as Error).message}`,
        );
      }
    }

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

    await this.publishFundingCompletedEvent(result);
  }

  async pollStaleFundingTransactions(): Promise<void> {
    const staleTransactions =
      await this.ledgerService.findStaleFundingTransactions(
        new Date(Date.now() - STALE_FUNDING_THRESHOLD_MS),
      );

    for (const transaction of staleTransactions) {
      await this.pollFundingTransaction(transaction);
    }
  }

  private async pollFundingTransaction(transaction: {
    reference: string;
    currency: string;
  }): Promise<void> {
    let verifyResult: VerifyChargeResult;
    try {
      verifyResult = await this.adapter.verifyCharge(transaction.reference);
    } catch (error) {
      this.logger.error(
        `pollStaleFundingTransactions: verifyCharge failed for reference "${transaction.reference}" (${(error as Error).message}) — will retry on the next poll run`,
      );
      return;
    }

    if (verifyResult.status === 'pending') {
      // Still awaiting checkout completion — leave it pending for a later
      // poll run rather than force-resolving it.
      return;
    }

    const facts: PostFundingFacts =
      verifyResult.status === 'success'
        ? {
            reference: transaction.reference,
            netAmount: verifyResult.netAmount,
            providerFee: verifyResult.providerFee,
            providerStatus: 'success',
          }
        : {
            reference: transaction.reference,
            // Unused by postFunding for a `failed` outcome — see
            // LedgerService.postFunding's early return before any entries
            // are posted.
            netAmount: Money.zero(transaction.currency),
            providerFee: Money.zero(transaction.currency),
            providerStatus: 'failed',
          };

    const result = await this.ledgerService.postFunding(facts);
    if (!result) {
      // The webhook (or an earlier poll tick) already resolved this —
      // no-op, not a duplicate posting.
      return;
    }

    await this.publishFundingCompletedEvent(result);
  }

  // The external reconciliation job (issue #15, docs/architecture.md §4.4)
  // — iterates every active (provider, currency) pair independently, so one
  // pair's failure doesn't stop the rest of the batch (same shape as
  // pollStaleFundingTransactions above).
  async reconcileFloatBalances(): Promise<void> {
    for (const pair of ACTIVE_RECONCILIATION_PAIRS) {
      try {
        await this.reconcilePair(pair);
      } catch (error) {
        this.logger.error(
          `reconcileFloatBalances: failed to reconcile ${pair.provider}/${pair.currency} (${(error as Error).message}) — will retry on the next run`,
        );
      }
    }
  }

  // Read-and-compare only — never writes to the ledger. A mismatch is
  // logged and alerted; a human investigates and corrects via a compensating
  // transaction, never this job (CLAUDE.md, "corrections are compensating
  // transactions, never mutations of history").
  private async reconcilePair(pair: ActiveReconciliationPair): Promise<void> {
    const [ledgerBalance, providerBalance] = await Promise.all([
      this.ledgerService.getFloatBalance(pair.provider, pair.currency),
      this.adapter.getBalance(pair.currency),
    ]);

    // Every run's result is logged, match or mismatch — §4.4's
    // "logged and reviewable" requirement.
    this.logger.debug(
      `reconcileFloatBalances: ${pair.provider}/${pair.currency} ledger=${ledgerBalance.toDecimalString()} provider=${providerBalance.toDecimalString()}`,
    );

    if (ledgerBalance.equals(providerBalance)) {
      return;
    }

    const delta = ledgerBalance.subtract(providerBalance);
    const occurredAt = new Date();
    this.logger.error(
      `reconcileFloatBalances: mismatch for ${pair.provider}/${pair.currency} — ledger=${ledgerBalance.toDecimalString()} provider=${providerBalance.toDecimalString()} delta=${delta.toDecimalString()}`,
    );

    await this.eventBus.publish<string, ReconciliationMismatchEventPayload>({
      name: RECONCILIATION_MISMATCH_EVENT,
      payload: {
        email: this.reconciliationAlertEmail,
        provider: pair.provider,
        currency: pair.currency,
        ledgerBalance: ledgerBalance.toDecimalString(),
        providerBalance: providerBalance.toDecimalString(),
        delta: delta.toDecimalString(),
        occurredAt: occurredAt.toISOString(),
      },
      occurredAt,
    });
  }

  private async publishFundingCompletedEvent(
    result: PostFundingResult,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(result.userId);
      await this.eventBus.publish<string, FundingCompletedEventPayload>({
        name: FUNDING_COMPLETED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.netAmount.toDecimalString(),
          currency: result.netAmount.currency,
          reference: result.reference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishFundingCompletedEvent: funding posted successfully for user "${result.userId}", but publishing the completion notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

// A reference belonging to another user must 409 with nothing about the
// other transaction attached (ADR-0010, defect 1) — the message here never
// touches `replay.transaction`. Returns null on 'none' so the caller falls
// through to actually creating the transaction.
function resolveFundingReplay(
  replay: IdempotentReplay,
): FundWalletResponseDto | null {
  switch (replay.outcome) {
    case 'match':
      return toFundWalletResponse(replay.transaction);
    case 'foreign':
      throw new ConflictException(
        'This reference has already been used for a different funding request.',
      );
    case 'diverged':
      throw new UnprocessableEntityException(
        'This reference was already used to fund with different parameters — use a new reference.',
      );
    case 'none':
      return null;
  }
}

function toFundWalletResponse(transaction: {
  status: string;
  metadata: { checkoutUrl: string | null };
}): FundWalletResponseDto {
  if (transaction.metadata.checkoutUrl) {
    return { checkoutUrl: transaction.metadata.checkoutUrl };
  }
  if (transaction.status === 'failed') {
    // markFundingTransactionFailed set this before a checkout URL ever
    // existed — the request never reached the provider, so "retry
    // shortly" would be a lie told forever (the row is terminal by
    // design — that's what the reference's uniqueness means). The client
    // needs a new reference to make a new attempt.
    throw new ConflictException(
      'This funding reference already failed to initiate and will not be retried — use a new reference to start a new attempt.',
    );
  }
  throw new ConflictException(
    'A funding request for this reference is already being processed — retry shortly.',
  );
}
