import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { AuthService } from '../auth/auth.service';
import { PaymentsService } from '../payments/payments.service';
import {
  IdempotentReplay,
  LedgerService,
  PostWithdrawalResult,
  TransactionHistoryPagination,
  WithdrawalTransactionMetadata,
} from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { KycService, LimitCheckOptions } from '../kyc/kyc.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
} from '../../shared/events/domain-events';
import { Money } from '../../shared/primitives/money';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  WITHDRAWAL_INITIATED_EVENT,
  WithdrawalInitiatedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import { BankAccount } from './entities/bank-account.entity';
import { SaveBankAccountDto } from './dto/save-bank-account.dto';
import {
  BankAccountResponseDto,
  toBankAccountResponse,
} from './dto/bank-account-response.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import { InitiateWithdrawalDto } from './dto/initiate-withdrawal.dto';
import { InitiateWithdrawalResponseDto } from './dto/initiate-withdrawal-response.dto';
import {
  WithdrawalHistoryItemDto,
  toWithdrawalHistoryItem,
} from './dto/withdrawal-history-item.dto';
import { holderNameMatchesLegalName } from './internal/name-match';
import {
  BankAccountAlreadySavedException,
  BankAccountCoolingException,
  BankAccountNotFoundException,
  BankAccountNotResolvableException,
  InitiatorAccountFrozenException,
  UnsupportedWithdrawalCurrencyException,
  WithdrawalAmountTooSmallException,
  WithdrawalPayoutFailedException,
} from './internal/errors';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../../shared/crypto/secrets.util';

// Structural, not imported from payments/adapters — that path isn't a
// cross-module entry point (only PaymentsService itself is), same reasoning
// as money-requests.service.ts's own CounterpartyUser type.
type ResolveBankAccountResult = Awaited<
  ReturnType<PaymentsService['resolveBankAccount']>
>;

const NGN = 'NGN'; // Withdrawals are NGN-only for now — same as transfers (issue #28).
const BANK_ACCOUNT_COOLING_MS = 24 * 60 * 60 * 1000;
const PROVIDER = 'kora'; // Same single-active-provider assumption payments.service.ts's fundWallet makes.

// `ledger`'s transactions.metadata is at-rest storage too, and has no
// operational need for the full number once the payout call has already
// been made with it — only the masked form goes into the snapshot ledger
// stores, so a second plaintext copy doesn't sit outside bank_accounts'
// encrypted column.
function maskAccountNumber(accountNumber: string): string {
  return (
    '*'.repeat(Math.max(accountNumber.length - 4, 0)) + accountNumber.slice(-4)
  );
}

export interface ExecuteScheduledWithdrawalParams {
  bankAccountId: string;
  amount: number; // minor units
  reference: string;
  scheduleId: string;
  runNumber: number;
  scheduleCreatedAt: Date;
}

export interface ExecuteScheduledWithdrawalOutcome {
  transactionId: string;
  // `unknown` means the provider's answer is not known yet; either way the
  // payout settles later through withdrawal_completed / withdrawal_failed.
  outcome: 'accepted' | 'unknown';
  replayed: boolean;
}

export type ScheduledWithdrawalRejectionCode =
  | 'insufficient_balance'
  | 'daily_limit_exceeded'
  | 'sender_frozen'
  | 'bank_account_removed'
  | 'payout_rejected'
  | 'sender_unverified'
  | 'amount_below_minimum'
  | 'security_cooldown_limit'
  | 'bank_account_cooling';

// A business refusal of a scheduled run, as opposed to an infrastructure
// fault: every other error escapes executeScheduledWithdrawal untouched.
export class ScheduledWithdrawalRejectedError extends Error {
  constructor(
    readonly failureCode: ScheduledWithdrawalRejectionCode,
    cause: unknown,
  ) {
    super(`Scheduled withdrawal rejected: ${failureCode}`, { cause });
  }
}

const SCHEDULED_REJECTION_BY_ERROR_CODE: Record<
  string,
  ScheduledWithdrawalRejectionCode
> = {
  INSUFFICIENT_FUNDS: 'insufficient_balance',
  DAILY_LIMIT_EXCEEDED: 'daily_limit_exceeded',
  KYC_VERIFICATION_REQUIRED: 'sender_unverified',
  WITHDRAWAL_AMOUNT_TOO_SMALL: 'amount_below_minimum',
  SECURITY_COOLDOWN_LIMIT: 'security_cooldown_limit',
  BANK_ACCOUNT_COOLING: 'bank_account_cooling',
  INITIATOR_ACCOUNT_FROZEN: 'sender_frozen',
  BANK_ACCOUNT_NOT_FOUND: 'bank_account_removed',
  WITHDRAWAL_PAYOUT_FAILED: 'payout_rejected',
};

function toScheduledRejection(
  error: unknown,
): ScheduledWithdrawalRejectedError | null {
  const code = (error as { code?: unknown } | null)?.code;
  const failureCode =
    typeof code === 'string' ? SCHEDULED_REJECTION_BY_ERROR_CODE[code] : null;
  return failureCode
    ? new ScheduledWithdrawalRejectedError(failureCode, error)
    : null;
}

interface WithdrawalRun {
  response: InitiateWithdrawalResponseDto;
  transactionId: string;
  outcome: 'accepted' | 'unknown';
  replayed: boolean;
}

interface WithdrawalReplay {
  response: InitiateWithdrawalResponseDto;
  transactionId: string;
}

/**
 * The one exported surface of the withdrawals module — see
 * docs/architecture.md §10 and ADR-0014. Owns `bank_accounts`; reaches
 * `payments` only for provider resolution and `auth` only for step-up MFA,
 * never `transfers`.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);
  private readonly encryptionKey: Buffer;
  private readonly identifierHashKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly paymentsService: PaymentsService,
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
    private readonly eventBus: EventBusService,
    private readonly auditService: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.encryptionKey = encryptionKeyFromHex(config.encryption.key);
    this.identifierHashKey = encryptionKeyFromHex(config.identifierHash.key);
  }

  private get bankAccountRepo(): Repository<BankAccount> {
    return this.dataSource.getRepository(BankAccount);
  }

  // docs/architecture.md §7 requires bank account numbers encrypted at
  // rest — `accountNumberCiphertext` holds the recoverable value,
  // `accountNumberHash` a deterministic HMAC used only for the uniqueness
  // constraint (a fresh IV means two encryptions of the same number never
  // match, so the ciphertext itself can't back that check).
  private decryptAccountNumber(bankAccount: BankAccount): string {
    return decryptSecret(
      bankAccount.accountNumberCiphertext,
      this.encryptionKey,
    );
  }

  // Step 1 of 2 — fires unconditionally regardless of trusted-device status
  // (docs/architecture.md §3.8 lists "bank accounts" among the changes
  // step-up must gate), same shape as change-password's 2-call flow: no new
  // value to deliver/confirm, just a live step-up proof consumed directly
  // by the save call below.
  async initiateSaveBankAccountStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiateStepUp(userId, 'save_bank_account');
  }

  // Step 2 of 2 — verifies the step-up challenge, resolves the account
  // against the provider, and only persists on a successful resolution.
  // `accountName`/`bankName` are always the provider-resolved values, never
  // taken from the client (issue #27).
  async saveBankAccount(
    userId: string,
    dto: SaveBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    await this.authService.verifyStepUp(userId, dto.challengeId, dto.code);

    const resolved: ResolveBankAccountResult =
      await this.paymentsService.resolveBankAccount(
        dto.bankCode,
        dto.accountNumber,
      );
    if (resolved.status === 'not_found') {
      throw new BankAccountNotResolvableException();
    }

    const legalName = await this.kycService.getVerifiedLegalName(userId);
    const now = new Date();
    const nameMatches = holderNameMatchesLegalName(
      resolved.accountName,
      legalName,
    );
    const bankAccount = this.bankAccountRepo.create({
      userId,
      provider: PROVIDER,
      bankCode: dto.bankCode,
      bankName: resolved.bankName,
      accountNumberCiphertext: encryptSecret(
        dto.accountNumber,
        this.encryptionKey,
      ),
      accountNumberHash: hmacHex(dto.accountNumber, this.identifierHashKey),
      accountName: resolved.accountName,
      fullyEligibleAt: nameMatches
        ? now
        : new Date(now.getTime() + BANK_ACCOUNT_COOLING_MS),
    });

    try {
      await runInTransaction(this.dataSource, async (manager) => {
        await manager.getRepository(BankAccount).save(bankAccount);
        await this.auditService.record(manager, {
          actor: { type: 'user', id: userId },
          action: 'bank_account_saved',
          subject: { type: 'bank_account', id: bankAccount.id },
          metadata: {
            bankCode: bankAccount.bankCode,
            accountNumberLast4: dto.accountNumber.slice(-4),
            holderNameMatched: nameMatches,
            fullyEligibleAt: bankAccount.fullyEligibleAt.toISOString(),
          },
        });
      });
    } catch (error) {
      if (
        isUniqueViolation(
          error,
          'UQ_bank_accounts_user_provider_bank_account_hash',
        )
      ) {
        throw new BankAccountAlreadySavedException();
      }
      throw error;
    }

    await this.publishBankAccountSavedAlert(bankAccount, dto.accountNumber);
    return toBankAccountResponse(bankAccount, dto.accountNumber);
  }

  private async publishBankAccountSavedAlert(
    bankAccount: BankAccount,
    accountNumber: string,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(bankAccount.userId);
      const occurredAt = new Date();
      await this.eventBus.publish<string, SecurityAlertEventPayload>({
        name: SECURITY_ALERT_EVENT,
        payload: {
          userId: bankAccount.userId,
          email: user.email,
          message: `A bank account was added to your Cliqpay account: ${bankAccount.bankName} ${maskAccountNumber(accountNumber)}, held by ${bankAccount.accountName}. If this wasn’t you, secure your account now.`,
          occurredAt: occurredAt.toISOString(),
        },
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `saveBankAccount: bank account ${bankAccount.id} saved, but publishing the security alert failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  // No "default" flag (issue #27) — every saved account is returned,
  // newest first, and a withdrawal request specifies bankAccountId
  // explicitly.
  async listBankAccounts(userId: string): Promise<BankAccountResponseDto[]> {
    const bankAccounts = await this.bankAccountRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return bankAccounts.map((bankAccount) =>
      toBankAccountResponse(
        bankAccount,
        this.decryptAccountNumber(bankAccount),
      ),
    );
  }

  // Issue #30. `withdrawals` owns this history the same way `ledger` owns
  // general wallet history (ADR-0014), scoped to `type: 'withdrawal'` —
  // ledger does the actual query (it owns `transactions`), this only
  // resolves the wallet and decorates the response.
  async getWithdrawalHistory(
    userId: string,
    pagination: TransactionHistoryPagination,
  ): Promise<PaginatedResult<WithdrawalHistoryItemDto>> {
    const wallet = await this.ledgerService.getUserWallet(userId);
    const result = await this.ledgerService.getWithdrawalHistory(
      wallet.id,
      pagination,
    );
    return {
      items: result.items.map(toWithdrawalHistoryItem),
      nextCursor: result.nextCursor,
    };
  }

  // Issue #28. Debit-first (docs/architecture.md §6 Phase 4): postWithdrawal
  // commits before payments.initiatePayout is ever called. A synchronous
  // rejection (or the call throwing outright) reverses what was just posted
  // via the same compensating-transaction path #29 reuses for the async
  // webhook-failure case.
  async initiateWithdrawal(
    userId: string,
    dto: InitiateWithdrawalDto,
  ): Promise<InitiateWithdrawalResponseDto> {
    const run = await this.processWithdrawal(userId, dto, dto.pin);
    return run.response;
  }

  /**
   * STANDING-AUTHORISATION SEAM — scheduled execution only. Skips the PIN
   * because the schedule's creator verified it once, as a mandate for every
   * run; everything else initiateWithdrawal checks still runs. Never call
   * this from a controller or from anything reachable by a client request.
   * A replay of a still-pending withdrawal succeeds; a replay of a reversed
   * one throws, like the live path.
   */
  async executeScheduledWithdrawal(
    userId: string,
    params: ExecuteScheduledWithdrawalParams,
  ): Promise<ExecuteScheduledWithdrawalOutcome> {
    try {
      const run = await this.processWithdrawal(
        userId,
        params,
        null,
        { scheduleId: params.scheduleId, runNumber: params.runNumber },
        { scheduleCreatedAt: params.scheduleCreatedAt },
      );
      return {
        transactionId: run.transactionId,
        outcome: run.outcome,
        replayed: run.replayed,
      };
    } catch (error) {
      throw toScheduledRejection(error) ?? error;
    }
  }

  async findScheduledWithdrawal(
    userId: string,
    reference: string,
    manager?: EntityManager,
  ): Promise<{
    transactionId: string;
    status: 'pending' | 'completed' | 'reversed';
  } | null> {
    const found = await this.ledgerService.findTransactionRefForUser(
      reference,
      userId,
      manager,
    );
    if (!found) {
      return null;
    }
    return {
      transactionId: found.id,
      status:
        found.status === 'completed' || found.status === 'reversed'
          ? found.status
          : 'pending',
    };
  }

  async getBankAccountLabel(
    userId: string,
    bankAccountId: string,
  ): Promise<string | null> {
    const bankAccount = await this.bankAccountRepo.findOneBy({
      id: bankAccountId,
      userId,
    });
    return bankAccount
      ? `${bankAccount.bankName} ••${this.decryptAccountNumber(bankAccount).slice(-4)}`
      : null;
  }

  // `pin` is null only for the scheduled seam.
  private async processWithdrawal(
    userId: string,
    dto: { bankAccountId: string; amount: number; reference: string },
    pin: string | null,
    extraMetadata?: Record<string, unknown>,
    limitOptions?: LimitCheckOptions,
  ): Promise<WithdrawalRun> {
    const { minAmount, platformFee, providerFee } = this.config.withdrawals;
    if (dto.amount < minAmount) {
      throw new WithdrawalAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }

    const bankAccount = await this.bankAccountRepo.findOneBy({
      id: dto.bankAccountId,
      userId,
    });
    if (!bankAccount) {
      throw new BankAccountNotFoundException();
    }

    const wallet = await this.ledgerService.getUserWallet(userId);
    // Defensive only (see UnsupportedWithdrawalCurrencyException) — no
    // currency field exists on the DTO today.
    if (wallet.currency !== NGN) {
      throw new UnsupportedWithdrawalCurrencyException();
    }

    const amount = Money.of(dto.amount, NGN);
    const platformFeeMoney = Money.of(platformFee, NGN);
    const providerFeeMoney = Money.of(providerFee, NGN);

    // No counterpartyWalletId — a withdrawal's destination is a bank
    // account, not another Cliqpay wallet, so ledger's generic fingerprint
    // has nothing to check there (see checkIdempotentReplay). Divergence on
    // *which* bank account is checked separately below, once a match comes
    // back — bank_accounts belongs to `withdrawals`, not `ledger`
    // (ADR-0014), so ledger's shared fingerprint can't cover it.
    const fingerprint = {
      type: 'withdrawal' as const,
      amount: amount.amount,
      currency: NGN,
    };
    const replay = await this.ledgerService.checkIdempotentReplay(
      dto.reference,
      userId,
      fingerprint,
    );
    const replayed = this.resolveWithdrawalReplay(replay, dto.bankAccountId);
    if (replayed) {
      return { ...replayed, outcome: 'accepted', replayed: true };
    }

    // PIN checked only after a replay match would have short-circuited
    // above — a retried, already-initiated withdrawal shouldn't demand the
    // PIN again, mirroring TransfersService.executeTransfer.
    const user = await this.usersService.findById(userId);
    if (pin !== null) {
      await this.authService.verifyTransactionPin(userId, pin);
    }

    const accountNumber = this.decryptAccountNumber(bankAccount);

    let posted: PostWithdrawalResult;
    try {
      posted = await runInTransaction(this.dataSource, async (manager) => {
        await this.kycService.checkAndReserveLimit(
          manager,
          userId,
          amount,
          (m, since) => this.ledgerService.getDebitedSince(m, userId, since),
          limitOptions,
        );
        await this.checkBankAccountCooling(
          manager,
          userId,
          bankAccount,
          amount,
        );
        if (
          (await this.usersService.getRestrictionState(manager, userId))
            .blocksOutbound
        ) {
          throw new InitiatorAccountFrozenException();
        }
        return this.ledgerService.postWithdrawalWithinTransaction(manager, {
          reference: dto.reference,
          walletId: wallet.id,
          provider: PROVIDER,
          amount,
          platformFee: platformFeeMoney,
          providerFee: providerFeeMoney,
          bankAccount: {
            id: bankAccount.id,
            bankCode: bankAccount.bankCode,
            bankName: bankAccount.bankName,
            accountNumber: maskAccountNumber(accountNumber),
            accountName: bankAccount.accountName,
          },
          extraMetadata,
        });
      });
    } catch (error) {
      // A racing duplicate may have committed first; its result is the answer.
      const raced = await this.ledgerService.checkIdempotentReplay(
        dto.reference,
        userId,
        fingerprint,
      );
      const racedReplay = this.resolveWithdrawalReplay(
        raced,
        dto.bankAccountId,
      );
      if (racedReplay) {
        return { ...racedReplay, outcome: 'accepted', replayed: true };
      }
      throw error;
    }

    // Only a confirmed `rejected` result reverses the already-posted entries
    // (see InitiatePayoutResult's `unknown` case). If this call itself
    // throws — a genuine bug, not a modeled outcome — the transaction is
    // left `pending` rather than reversed, for the same reason: an
    // exception here doesn't confirm Kora rejected the payout, and
    // reversing on an unconfirmed outcome risks double-crediting the wallet
    // while the bank transfer still lands.
    const payoutResult = await this.paymentsService.initiatePayout({
      reference: dto.reference,
      amount,
      bankCode: bankAccount.bankCode,
      accountNumber,
      accountName: bankAccount.accountName,
      customerEmail: user.email,
    });

    if (payoutResult.status === 'rejected') {
      await this.ledgerService.reverseWithdrawal({
        reference: dto.reference,
        reason: payoutResult.reason,
      });
      throw new WithdrawalPayoutFailedException(payoutResult.reason);
    }
    if (payoutResult.status === 'unknown') {
      this.logger.warn(
        `initiateWithdrawal: payout outcome unknown for reference "${dto.reference}" (${payoutResult.detail}) — left pending for webhook/reconciliation`,
      );
    }

    await this.publishWithdrawalInitiatedEvent(
      posted,
      bankAccount,
      accountNumber,
      user,
    );

    return {
      response: {
        reference: posted.reference,
        amount: posted.amount.toJSON(),
        platformFee: posted.platformFee.toJSON(),
        providerFee: posted.providerFee.toJSON(),
        status: 'pending',
        createdAt: posted.createdAt.toISOString(),
      },
      transactionId: posted.transactionId,
      outcome: payoutResult.status === 'unknown' ? 'unknown' : 'accepted',
      replayed: false,
    };
  }

  // Runs under the user's lock, taken by the limit check just before it.
  private async checkBankAccountCooling(
    manager: EntityManager,
    userId: string,
    bankAccount: BankAccount,
    amount: Money,
  ): Promise<void> {
    if (bankAccount.fullyEligibleAt.getTime() <= Date.now()) {
      return;
    }
    const cap = Money.of(
      this.config.securityControls.bankAccountCoolingLimit,
      NGN,
    );
    const withdrawn = await this.ledgerService.getWithdrawnToBankAccount(
      manager,
      userId,
      bankAccount.id,
    );
    if (withdrawn.add(amount).greaterThan(cap)) {
      throw new BankAccountCoolingException(
        bankAccount.fullyEligibleAt,
        cap,
        cap.greaterThan(withdrawn) ? cap.subtract(withdrawn) : Money.zero(NGN),
      );
    }
  }

  // A reference belonging to another user must 409 with nothing about the
  // other withdrawal attached (ADR-0010, defect 1). A match whose stored
  // bank account differs from this request's is a divergent replay
  // (ADR-0010, defect 2) even though ledger's own fingerprint check passed —
  // bank_accounts is withdrawals' table, not ledger's, so that check lives
  // here. A matched transaction that was since reversed (this issue's
  // synchronous-rejection path, or #29's webhook-failure path) must not
  // replay as a false success — the client gets the same failure a fresh
  // attempt would have surfaced.
  private resolveWithdrawalReplay(
    replay: IdempotentReplay,
    bankAccountId: string,
  ): WithdrawalReplay | null {
    switch (replay.outcome) {
      case 'match': {
        const metadata = replay.transaction
          .metadata as unknown as WithdrawalTransactionMetadata;
        if (metadata.bankAccount.id !== bankAccountId) {
          throw new UnprocessableEntityException(
            'This reference was already used to withdraw to a different bank account — use a new reference.',
          );
        }
        if (replay.transaction.status === 'reversed') {
          throw new WithdrawalPayoutFailedException(
            'this withdrawal was already rejected by the provider',
          );
        }
        return {
          transactionId: replay.transaction.id,
          response: {
            reference: replay.transaction.reference,
            amount: Money.of(
              replay.transaction.amount,
              replay.transaction.currency,
            ).toJSON(),
            platformFee: metadata.platformFee,
            providerFee: metadata.providerFee,
            status: 'pending',
            createdAt: replay.transaction.createdAt.toISOString(),
          },
        };
      }
      case 'foreign':
        throw new ConflictException(
          'This reference has already been used for a different withdrawal.',
        );
      case 'diverged':
        throw new UnprocessableEntityException(
          'This reference was already used to withdraw a different amount — use a new reference.',
        );
      case 'none':
        return null;
    }
  }

  private async publishWithdrawalInitiatedEvent(
    result: PostWithdrawalResult,
    bankAccount: BankAccount,
    accountNumber: string,
    user: { email: string },
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, WithdrawalInitiatedEventPayload>({
        name: WITHDRAWAL_INITIATED_EVENT,
        payload: {
          userId: result.userId,
          email: user.email,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          bankName: bankAccount.bankName,
          accountNumberLast4: accountNumber.slice(-4),
          reference: result.reference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishWithdrawalInitiatedEvent: withdrawal posted successfully (reference "${result.reference}"), but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
