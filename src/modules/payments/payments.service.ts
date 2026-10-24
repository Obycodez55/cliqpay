import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { KycService } from '../kyc/kyc.service';
import { runInTransaction } from '../../database/transaction.util';
import { Money } from '../../shared/primitives/money';
import {
  FUNDING_COMPLETED_EVENT,
  FUNDING_HELD_EVENT,
  FUNDING_REFUNDED_EVENT,
  FundingCompletedEventPayload,
  FundingHeldEventPayload,
  FundingRefundedEventPayload,
  REFUND_ATTENTION_REQUIRED_EVENT,
  RefundAttentionReason,
  RefundAttentionRequiredEventPayload,
  RECONCILIATION_MISMATCH_EVENT,
  ReconciliationMismatchEventPayload,
  WITHDRAWAL_COMPLETED_EVENT,
  WithdrawalCompletedEventPayload,
  WITHDRAWAL_FAILED_EVENT,
  WithdrawalFailedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';
import { WalletLimitsResponseDto } from './dto/wallet-limits-response.dto';
import {
  InitiatePaymentResult,
  InitiatePayoutParams,
  InitiatePayoutResult,
  InitiateRefundResult,
  PAYMENT_PROVIDER_ADAPTER,
  PaymentProviderAdapter,
  ResolveBankAccountResult,
  VerifyChargeResult,
  VerifyPayoutResult,
} from './adapters/payment-provider.interface';
import { extractTopLevelJsonField } from './internal/raw-json';
import {
  CompleteWithdrawalResult,
  HoldFundingResult,
  IdempotentReplay,
  PostFundingFacts,
  PostFundingResult,
  ReverseWithdrawalResult,
  SettleRefundResult,
  StalePendingRefund,
} from '../ledger/ledger.service';
import {
  ACTIVE_RECONCILIATION_PAIRS,
  ActiveReconciliationPair,
} from './internal/active-reconciliation-pairs';

const NGN = 'NGN'; // Funding is NGN-only for now — see issue #12.

const STALE_FUNDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STALE_WITHDRAWAL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STALE_REFUND_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Kora answers a second attempt on the same payment with a 429 for about a
// minute, and never accepts a refund reference twice, so each retry is a new
// attempt after a wait. Element n is the wait after attempt n fails.
const REFUND_RETRY_DELAYS_MS = [
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const MAX_REFUND_ATTEMPTS = REFUND_RETRY_DELAYS_MS.length + 1;
const HELD_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const REFUND_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

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

// Ground truth: developers.korapay.com/docs/webhooks (issue #29) confirms
// the payload envelope is `{ event: "transfer.success" | "transfer.failed",
// data: { reference, amount, fee, currency, status, ... } }` — the same
// `data` shape as charge events (see KoraChargeWebhookData above), just
// under `transfer.*` rather than `charge.*`. A real sandbox disbursement
// (POST /merchant/api/v1/transactions/disburse, then GET
// /merchant/api/v1/transactions/{reference}) run for this issue separately
// confirmed ADR-0007's Phase 4 correction still holds for the `data` shape
// itself — `reference` is exactly what we sent, `amount` a decimal string
// ("1000.00"), terminal `status` values "success"/"failed". The actual
// webhook *delivery* couldn't be captured in this environment (no publicly
// reachable receiver was available here) — the `data` shape is taken on
// the strength of the docs and the matching status-endpoint response, not
// a directly observed webhook, unlike ADR-0007's funding webhook capture.
// Flagged for confirmation against a real captured delivery before this
// handles production traffic.
interface KoraPayoutWebhookData {
  reference: string;
  status: string;
  amount: string | number;
  message?: string;
}

function validatePayoutWebhookData(parsed: unknown): KoraPayoutWebhookData {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Malformed webhook payload');
  }
  const { reference, status, amount, message } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    typeof status !== 'string' ||
    status.length === 0 ||
    (typeof amount !== 'string' && typeof amount !== 'number')
  ) {
    throw new BadRequestException('Malformed webhook payload');
  }
  return {
    reference,
    status,
    amount,
    message: typeof message === 'string' ? message : undefined,
  };
}

// Ground truth: docs/research/kora-refunds.md, captured refund webhooks.
// `reference` is our refund reference; `payment_reference` is a Kora-internal
// id and is deliberately not read. `amount` is the refund's own amount.
interface KoraRefundWebhookData {
  reference: string;
  status: string;
  amount: string | number;
  statusReason?: string;
}

function validateRefundWebhookData(parsed: unknown): KoraRefundWebhookData {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Malformed webhook payload');
  }
  const { reference, status, amount, status_reason } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    typeof status !== 'string' ||
    status.length === 0 ||
    (typeof amount !== 'string' && typeof amount !== 'number')
  ) {
    throw new BadRequestException('Malformed webhook payload');
  }
  return {
    reference,
    status,
    amount,
    statusReason: typeof status_reason === 'string' ? status_reason : undefined,
  };
}

const REFUND_REASON = 'Wallet balance limit exceeded';

type RefundRequest = Pick<
  HoldFundingResult,
  'refundReference' | 'fundingReference' | 'netAmount'
>;

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
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
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
    // operation here, per ADR-0010. `type` guards against a reference
    // reused across a different transaction type entirely (Phase 3
    // end-of-phase audit) — without it, a P2P transfer sharing this
    // reference and amount could falsely "match" here.
    const fingerprint = {
      type: 'funding' as const,
      amount: amount.amount,
      currency: amount.currency,
    };

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
      await runInTransaction(this.dataSource, async (manager) => {
        await this.kycService.checkBalanceCap(manager, userId, amount, (m) =>
          this.ledgerService.getBalanceAndPendingFunding(m, userId),
        );
        await this.ledgerService.createPendingFundingTransactionWithinTransaction(
          manager,
          {
            reference: dto.reference,
            provider: 'kora',
            providerReference: dto.reference,
            amount,
            recipientWalletId: wallet.id,
            metadata: { checkoutUrl: null, grossAmount: null },
          },
        );
      });
    } catch (error) {
      // A racing duplicate may have committed first; its result is the answer.
      const raced = await this.ledgerService.checkIdempotentReplay(
        dto.reference,
        userId,
        fingerprint,
      );
      const racedResponse = resolveFundingReplay(raced);
      if (racedResponse) {
        return racedResponse;
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

  async getWalletLimits(userId: string): Promise<WalletLimitsResponseDto> {
    const capacity = await runInTransaction(this.dataSource, (manager) =>
      this.kycService.getWalletCapacity(manager, userId, NGN, {
        readDebitedSince: (m, since) =>
          this.ledgerService.getDebitedSince(m, userId, since),
        readBalanceAndPending: (m) =>
          this.ledgerService.getBalanceAndPendingFunding(m, userId),
      }),
    );
    return {
      tier: capacity.tier,
      dailyLimit: capacity.dailyLimit.toJSON(),
      debitedToday: capacity.debitedToday.toJSON(),
      remainingToday: capacity.remainingToday.toJSON(),
      resetsAt: capacity.resetsAt.toISOString(),
      balanceCap: capacity.balanceCap?.toJSON() ?? null,
      balance: capacity.balance.toJSON(),
      pendingFunding: capacity.pendingFunding.toJSON(),
      headroom: capacity.headroom?.toJSON() ?? null,
    };
  }

  // Signature verified against the raw bytes Kora actually signed (see
  // KoraAdapter.verifyWebhookSignature) — invalid signature never reaches
  // the ledger, never changes any transaction's status (ADR-0008, issue
  // #13). Kora delivers every event (charges, transfers, refunds) to this
  // one dashboard-configured URL — confirmed against developers.korapay.com/
  // docs/webhooks during issue #29's design, which corrects an earlier,
  // wrong assumption that payouts would arrive on a separate endpoint —
  // there's nowhere else to route them, so this is the single entry point
  // and it dispatches on the payload's own `event` field.
  async handleKoraWebhook(
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
    // different one got posted. `event` (below) doesn't need this same
    // exact-slice care — it only selects which branch runs, it's never
    // itself treated as a financial fact, and each branch's own lookup is
    // additionally scoped by transaction `type` (see postFunding/
    // completeWithdrawal/reverseWithdrawal), so a wrongly- or duplicately-
    // labeled `event` can only ever fail to match rather than misapply one
    // event's facts as another's.
    const rawData = extractTopLevelJsonField(rawBody, 'data');
    if (!rawData) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    let envelope: unknown;
    let parsedData: unknown;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
      parsedData = JSON.parse(rawData.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook payload');
    }
    const event =
      typeof envelope === 'object' &&
      envelope !== null &&
      typeof (envelope as Record<string, unknown>).event === 'string'
        ? ((envelope as Record<string, unknown>).event as string)
        : undefined;

    if (event === 'transfer.success' || event === 'transfer.failed') {
      return this.processPayoutWebhookData(parsedData);
    }
    if (event === 'charge.success' || event === 'charge.failed') {
      return this.processFundingWebhookData(parsedData);
    }
    if (event === 'refund.success' || event === 'refund.failed') {
      return this.processRefundWebhookData(parsedData);
    }
    // An absent or unrecognized `event` on what Kora's real webhook and this
    // repo's own tests always send is logged and ignored, not defaulted to
    // any handler.
    this.logger.debug(
      `handleKoraWebhook: unrecognized or missing event "${String(event)}" — ignoring`,
    );
  }

  // Everything past signature verification is provider-fact mapping only:
  // this owns no accounting knowledge, LedgerService.postFunding decides
  // what these facts post to.
  private async processFundingWebhookData(parsed: unknown): Promise<void> {
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
        `processFundingWebhookData: non-terminal status "${data.status}" for reference "${data.reference}" — leaving pending`,
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

    await this.completeFunding({
      reference: data.reference,
      netAmount,
      providerFee,
      providerStatus,
    });
  }

  // The one path a funding outcome takes, from the webhook and the poll
  // alike. A success is checked against the user's balance cap under their
  // advisory lock, in the same transaction that posts it: credited when it
  // fits, held in suspense when it would breach the cap (docs/adr/0021). A
  // failed outcome moves no money, so it skips the check.
  private async completeFunding(facts: PostFundingFacts): Promise<void> {
    const owner =
      facts.providerStatus === 'success'
        ? await this.ledgerService.findPendingFundingOwner(facts.reference)
        : null;
    if (!owner) {
      // Failed, unknown or already resolved: postFunding is idempotent and
      // handles each.
      const result = await this.ledgerService.postFunding(facts);
      if (result) {
        await this.publishFundingCompletedEvent(result);
      }
      return;
    }

    const outcome = await runInTransaction(this.dataSource, async (manager) => {
      const verdict = await this.kycService.checkIncomingCredit(
        manager,
        owner.userId,
        facts.netAmount,
        (m) => this.ledgerService.getWalletBalance(m, owner.userId),
      );
      if (verdict.allowed) {
        const credited = await this.ledgerService.postFundingWithinTransaction(
          manager,
          facts,
        );
        return credited ? { kind: 'credited' as const, credited } : null;
      }
      const held = await this.ledgerService.holdFundingWithinTransaction(
        manager,
        facts,
      );
      return held ? { kind: 'held' as const, held, cap: verdict.cap } : null;
    });
    if (!outcome) {
      // A duplicate delivery, or the poll and the webhook racing: the other
      // one already resolved it.
      return;
    }
    if (outcome.kind === 'credited') {
      await this.publishFundingCompletedEvent(outcome.credited);
      return;
    }
    this.logger.warn(
      `completeFunding: funding "${outcome.held.fundingReference}" would take the wallet over its balance cap — held in suspense, refund attempt "${outcome.held.refundReference}" pending`,
    );
    await this.publishFundingHeldEvent(outcome.held, outcome.cap);
    await this.initiateRefund(outcome.held);
  }

  // Runs only after the hold has committed (CLAUDE.md: provider calls never
  // sit inside a DB transaction). Whatever happens here, the money is safe
  // in suspense and the pending attempt row is durable, so nothing is
  // thrown: a failure must not turn the webhook into a non-2xx that Kora
  // retries into the idempotency guard.
  private async initiateRefund(held: RefundRequest): Promise<void> {
    let result: InitiateRefundResult;
    try {
      result = await this.adapter.initiateRefund({
        reference: held.refundReference,
        paymentReference: held.fundingReference,
        amount: held.netAmount,
        reason: REFUND_REASON,
      });
    } catch (error) {
      this.logger.error(
        `initiateRefund: refund "${held.refundReference}" could not be started (${(error as Error).message}) — attempt left pending`,
      );
      return;
    }

    if (result.status === 'rejected') {
      await this.ledgerService.failRefund({
        refundReference: held.refundReference,
        reason: result.reason,
      });
      this.logger.error(
        `initiateRefund: refund "${held.refundReference}" rejected by the provider (${result.reason}) — funding stays held`,
      );
    } else if (result.status === 'unknown') {
      this.logger.warn(
        `initiateRefund: no confirmed answer for refund "${held.refundReference}" (${result.detail}) — attempt left pending`,
      );
    }
  }

  private async processRefundWebhookData(parsed: unknown): Promise<void> {
    const data = validateRefundWebhookData(parsed);

    if (data.status !== 'success' && data.status !== 'failed') {
      this.logger.debug(
        `processRefundWebhookData: non-terminal status "${data.status}" for refund "${data.reference}" — leaving pending`,
      );
      return;
    }

    if (data.status === 'failed') {
      await this.ledgerService.failRefund({
        refundReference: data.reference,
        reason: data.statusReason ?? 'Refund failed',
      });
      return;
    }

    let amount: Money;
    try {
      amount = Money.fromDecimalString(String(data.amount), NGN);
    } catch (error) {
      throw new BadRequestException(
        `Malformed webhook payload: ${(error as Error).message}`,
      );
    }
    const result = await this.ledgerService.settleRefund({
      refundReference: data.reference,
      providerReportedAmount: amount,
    });
    if (!result) {
      // Usually a duplicate delivery, an unknown reference or a mismatched
      // amount. A success for an attempt that did not settle the funding,
      // when the funding is already refunded, means Kora paid out twice.
      await this.alertOnLateSuccess(data.reference);
      return;
    }
    await this.publishFundingRefundedEvent(result);
  }

  private async alertOnLateSuccess(refundReference: string): Promise<void> {
    const context = await this.ledgerService.findRefundContext(refundReference);
    if (
      !context ||
      context.fundingStatus !== 'refunded' ||
      context.attemptStatus === 'completed'
    ) {
      return;
    }
    await this.publishRefundAttention({
      reason: 'late_success_after_refunded',
      fundingReference: context.fundingReference,
      refundReference,
      amount: context.netAmount,
      heldSince: null,
      attempts: null,
      lastFailure: null,
    });
  }

  // The refund recovery job (docs/adr/0021): every step is independent, so
  // one failing does not stop the others, and the whole run is safe to repeat.
  async pollStaleRefundTransactions(): Promise<void> {
    const steps: [string, () => Promise<void>][] = [
      ['resolve stale refunds', () => this.resolveStaleRefunds()],
      ['start refund retries', () => this.retryFailedRefunds()],
      ['alert on held fundings', () => this.alertOnHeldFundings()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        this.logger.error(
          `pollStaleRefundTransactions: failed to ${name} (${(error as Error).message}) — will retry on the next run`,
        );
      }
    }
  }

  private async resolveStaleRefunds(): Promise<void> {
    const stale = await this.ledgerService.findStalePendingRefunds(
      new Date(Date.now() - STALE_REFUND_THRESHOLD_MS),
    );
    for (const refund of stale) {
      try {
        await this.resolveStaleRefund(refund);
      } catch (error) {
        this.logger.error(
          `pollStaleRefundTransactions: could not resolve refund "${refund.refundReference}" (${(error as Error).message}) — will retry on the next run`,
        );
      }
    }
  }

  private async resolveStaleRefund(refund: StalePendingRefund): Promise<void> {
    const result = await this.adapter.verifyRefund(refund.refundReference);
    switch (result.status) {
      case 'pending':
        return;
      case 'not_found':
        // The initiate call never reached Kora, so the same reference is
        // still unused and safe to send again.
        await this.initiateRefund(refund);
        return;
      case 'failed':
        await this.ledgerService.failRefund({
          refundReference: refund.refundReference,
          reason: result.reason,
        });
        return;
      case 'success': {
        const settled = await this.ledgerService.settleRefund({
          refundReference: refund.refundReference,
          providerReportedAmount: result.amount,
        });
        if (settled) {
          await this.publishFundingRefundedEvent(settled);
        } else {
          await this.alertOnLateSuccess(refund.refundReference);
        }
        return;
      }
    }
  }

  private async retryFailedRefunds(): Promise<void> {
    const now = Date.now();
    for (const held of await this.ledgerService.findHeldFundings()) {
      if (
        held.hasPendingAttempt ||
        !held.lastAttemptFailedAt ||
        held.attempts >= MAX_REFUND_ATTEMPTS ||
        now - held.lastAttemptFailedAt.getTime() <
          REFUND_RETRY_DELAYS_MS[held.attempts - 1]
      ) {
        continue;
      }
      const next = await this.ledgerService.startRefundAttempt(
        held.fundingTransactionId,
      );
      if (next) {
        await this.initiateRefund({
          refundReference: next.refundReference,
          fundingReference: held.fundingReference,
          netAmount: held.netAmount,
        });
      }
    }
  }

  // One alert per reason per day: the last send time lives on the funding,
  // so it survives restarts and a run that is repeated.
  private async alertOnHeldFundings(): Promise<void> {
    const now = Date.now();
    for (const held of await this.ledgerService.findHeldFundings()) {
      const exhausted =
        !held.hasPendingAttempt &&
        held.attempts >= MAX_REFUND_ATTEMPTS &&
        held.lastAttemptFailedAt !== null;
      const reasons: RefundAttentionReason[] = [];
      if (exhausted) {
        reasons.push('retries_exhausted');
      }
      if (now - held.heldSince.getTime() >= HELD_TOO_LONG_MS) {
        reasons.push('held_too_long');
      }
      const due = reasons.filter((reason) => {
        const last = held.alerts[reason];
        return (
          !last || now - new Date(last).getTime() >= REFUND_ALERT_REPEAT_MS
        );
      });
      if (due.length === 0) {
        continue;
      }
      const sent: string[] = [];
      for (const reason of due) {
        const published = await this.publishRefundAttention({
          reason,
          fundingReference: held.fundingReference,
          refundReference: null,
          amount: held.netAmount,
          heldSince: held.heldSince,
          attempts: held.attempts,
          lastFailure: held.lastFailureReason,
        });
        if (published) {
          sent.push(reason);
        }
      }
      if (sent.length > 0) {
        await this.ledgerService.setRefundAlerts(held.fundingTransactionId, {
          ...held.alerts,
          ...Object.fromEntries(
            sent.map((reason) => [reason, new Date(now).toISOString()]),
          ),
        });
      }
    }
  }

  private async publishRefundAttention(alert: {
    reason: RefundAttentionReason;
    fundingReference: string;
    refundReference: string | null;
    amount: Money;
    heldSince: Date | null;
    attempts: number | null;
    lastFailure: string | null;
  }): Promise<boolean> {
    const occurredAt = new Date();
    this.logger.error(
      `refund needs attention (${alert.reason}): funding "${alert.fundingReference}", ${alert.amount.toDecimalString()}`,
    );
    try {
      await this.eventBus.publish<string, RefundAttentionRequiredEventPayload>({
        name: REFUND_ATTENTION_REQUIRED_EVENT,
        payload: {
          email: this.reconciliationAlertEmail,
          reason: alert.reason,
          fundingReference: alert.fundingReference,
          refundReference: alert.refundReference,
          amount: alert.amount.toDecimalString(),
          currency: alert.amount.currency,
          heldSince: alert.heldSince?.toISOString() ?? null,
          attempts: alert.attempts,
          lastFailure: alert.lastFailure,
          occurredAt: occurredAt.toISOString(),
        },
        occurredAt,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `publishRefundAttention: could not publish the ${alert.reason} alert for "${alert.fundingReference}" (${(error as Error).message}) — it will be retried on the next run if still due`,
      );
      return false;
    }
  }

  // Issue #29. Resolves whichever of the two `pending` origins the
  // withdrawal is sitting in (a synchronously `accepted` payout, or one
  // left `pending` after an `unknown` initiate outcome — see
  // InitiatePayoutResult) — from the webhook's perspective both are just a
  // pending withdrawal transaction that now has a final answer, so there's
  // one code path here, not two.
  private async processPayoutWebhookData(parsed: unknown): Promise<void> {
    const data = validatePayoutWebhookData(parsed);

    if (data.status !== 'success' && data.status !== 'failed') {
      this.logger.debug(
        `processPayoutWebhookData: non-terminal status "${data.status}" for reference "${data.reference}" — leaving pending`,
      );
      return;
    }

    if (data.status === 'failed') {
      // reverseWithdrawal reads the reversal amount from the original
      // transaction's own stored metadata, never from this webhook payload
      // — nothing here needs (or trusts) a reported amount for the failure
      // path, unlike the success path below.
      const reason = data.message ?? 'Payout failed';
      const result = await this.ledgerService.reverseWithdrawal({
        reference: data.reference,
        reason,
      });
      if (!result) {
        // Duplicate delivery of an already-resolved transaction — no-op.
        return;
      }
      await this.publishWithdrawalFailedEvent(result, reason);
      return;
    }

    let providerAmount: Money;
    try {
      providerAmount = Money.fromDecimalString(String(data.amount), NGN);
    } catch (error) {
      throw new BadRequestException(
        `Malformed webhook payload: ${(error as Error).message}`,
      );
    }

    const result = await this.ledgerService.completeWithdrawal({
      reference: data.reference,
      providerReportedAmount: providerAmount,
    });
    if (!result) {
      // Duplicate delivery, an unresolved reference, or a mismatched
      // amount left pending for investigation (see
      // LedgerService.completeWithdrawal) — either way, nothing to publish.
      return;
    }
    await this.publishWithdrawalCompletedEvent(result);
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

    await this.completeFunding(facts);
  }

  // The withdrawal self-verify poll job (issue #31, mirrors #14's funding
  // poll) — recovers a withdrawal left `pending` because Kora's payout
  // webhook never arrived.
  async pollStaleWithdrawalTransactions(): Promise<void> {
    const staleTransactions =
      await this.ledgerService.findStaleWithdrawalTransactions(
        new Date(Date.now() - STALE_WITHDRAWAL_THRESHOLD_MS),
      );

    for (const transaction of staleTransactions) {
      await this.pollWithdrawalTransaction(transaction);
    }
  }

  private async pollWithdrawalTransaction(transaction: {
    reference: string;
  }): Promise<void> {
    let verifyResult: VerifyPayoutResult;
    try {
      verifyResult = await this.adapter.verifyPayout(transaction.reference);
    } catch (error) {
      this.logger.error(
        `pollStaleWithdrawalTransactions: verifyPayout failed for reference "${transaction.reference}" (${(error as Error).message}) — will retry on the next poll run`,
      );
      return;
    }

    if (verifyResult.status === 'pending') {
      // Still processing at the provider — leave it pending for a later
      // poll run rather than force-resolving it.
      this.logger.debug(
        `pollStaleWithdrawalTransactions: reference "${transaction.reference}" still pending at provider`,
      );
      return;
    }

    if (verifyResult.status === 'failed') {
      const result = await this.ledgerService.reverseWithdrawal({
        reference: transaction.reference,
        reason: verifyResult.reason,
      });
      if (!result) {
        // The webhook (or an earlier poll tick) already resolved this —
        // no-op, not a duplicate reversal.
        return;
      }
      await this.publishWithdrawalFailedEvent(result, verifyResult.reason);
      return;
    }

    const result = await this.ledgerService.completeWithdrawal({
      reference: transaction.reference,
      providerReportedAmount: verifyResult.amount,
    });
    if (!result) {
      // The webhook (or an earlier poll tick) already resolved this, or the
      // provider-reported amount didn't cross-check — either way, nothing
      // further to publish here.
      return;
    }
    await this.publishWithdrawalCompletedEvent(result);
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

  private async publishFundingHeldEvent(
    held: HoldFundingResult,
    cap: Money,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(held.userId);
      await this.eventBus.publish<string, FundingHeldEventPayload>({
        name: FUNDING_HELD_EVENT,
        payload: {
          userId: held.userId,
          email: user.email,
          amount: held.netAmount.toDecimalString(),
          currency: held.netAmount.currency,
          reference: held.fundingReference,
          cap: cap.toDecimalString(),
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishFundingHeldEvent: funding "${held.fundingReference}" was held, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishFundingRefundedEvent(
    result: SettleRefundResult,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(result.userId);
      await this.eventBus.publish<string, FundingRefundedEventPayload>({
        name: FUNDING_REFUNDED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.netAmount.toDecimalString(),
          currency: result.netAmount.currency,
          reference: result.fundingReference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishFundingRefundedEvent: refund "${result.refundReference}" settled, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishWithdrawalCompletedEvent(
    result: CompleteWithdrawalResult,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(result.userId);
      await this.eventBus.publish<string, WithdrawalCompletedEventPayload>({
        name: WITHDRAWAL_COMPLETED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishWithdrawalCompletedEvent: withdrawal completed successfully (reference "${result.reference}"), but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishWithdrawalFailedEvent(
    result: ReverseWithdrawalResult,
    reason: string,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(result.userId);
      await this.eventBus.publish<string, WithdrawalFailedEventPayload>({
        name: WITHDRAWAL_FAILED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
          reason,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishWithdrawalFailedEvent: withdrawal reversal posted successfully (reference "${result.reference}"), but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  // Issue #27 — a thin pass-through to the adapter: `payments` owns no
  // `bank_accounts` table (ADR-0008), so this hands back the provider's own
  // resolved facts and lets the caller (`withdrawals`) decide what to do
  // with them.
  resolveBankAccount(
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolveBankAccountResult> {
    return this.adapter.resolveBankAccount(bankCode, accountNumber);
  }

  // Issue #28 — same thin pass-through shape as resolveBankAccount above:
  // `payments` owns no withdrawal-orchestration state (ADR-0014), so this
  // hands back the provider's own outcome and lets `withdrawals` decide
  // what to do with it (reverse on `rejected`).
  initiatePayout(params: InitiatePayoutParams): Promise<InitiatePayoutResult> {
    return this.adapter.initiatePayout(params);
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
      return toFundWalletResponse({
        status: replay.transaction.status,
        metadata: replay.transaction.metadata as unknown as Record<
          string,
          unknown
        >,
      });
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
  // Untyped, not the funding-shaped metadata directly — checkIdempotentReplay
  // is shared across every transaction type (funding, transfers), so its
  // TypeScript shape can't promise a funding-shaped metadata payload here.
  // In practice this is only ever called with a funding transaction, since
  // PaymentsService is the only caller of checkIdempotentReplay with a
  // funding reference.
  metadata: Record<string, unknown>;
}): FundWalletResponseDto {
  const checkoutUrl = transaction.metadata.checkoutUrl as string | null;
  if (checkoutUrl) {
    return { checkoutUrl };
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
