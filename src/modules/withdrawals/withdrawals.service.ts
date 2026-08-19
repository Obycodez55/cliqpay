import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { AuthService } from '../auth/auth.service';
import { PaymentsService } from '../payments/payments.service';
import {
  IdempotentReplay,
  LedgerService,
  PostWithdrawalResult,
  WithdrawalTransactionMetadata,
} from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Money } from '../../shared/primitives/money';
import {
  WITHDRAWAL_INITIATED_EVENT,
  WithdrawalInitiatedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { isUniqueViolation } from '../../database/postgres-errors.util';
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
  BankAccountAlreadySavedException,
  BankAccountNotFoundException,
  BankAccountNotResolvableException,
  UnsupportedWithdrawalCurrencyException,
  WithdrawalAmountTooLargeException,
  WithdrawalAmountTooSmallException,
  WithdrawalPayoutFailedException,
} from './internal/errors';

// Structural, not imported from payments/adapters — that path isn't a
// cross-module entry point (only PaymentsService itself is), same reasoning
// as money-requests.service.ts's own CounterpartyUser type.
type ResolveBankAccountResult = Awaited<
  ReturnType<PaymentsService['resolveBankAccount']>
>;

const NGN = 'NGN'; // Withdrawals are NGN-only for now — same as transfers (issue #28).
const PROVIDER = 'kora'; // Same single-active-provider assumption payments.service.ts's fundWallet makes.

/**
 * The one exported surface of the withdrawals module — see
 * docs/architecture.md §10 and ADR-0014. Owns `bank_accounts`; reaches
 * `payments` only for provider resolution and `auth` only for step-up MFA,
 * never `transfers`.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @InjectRepository(BankAccount)
    private readonly bankAccountRepo: Repository<BankAccount>,
    private readonly authService: AuthService,
    private readonly paymentsService: PaymentsService,
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Step 1 of 2 — fires unconditionally regardless of trusted-device status
  // (docs/architecture.md §3.8 lists "bank accounts" among the changes
  // step-up must gate), same shape as change-password's 2-call flow: no new
  // value to deliver/confirm, just a live step-up proof consumed directly
  // by the save call below.
  async initiateSaveBankAccountStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiateStepUp(userId);
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

    const bankAccount = this.bankAccountRepo.create({
      userId,
      provider: PROVIDER,
      bankCode: dto.bankCode,
      bankName: resolved.bankName,
      accountNumber: dto.accountNumber,
      accountName: resolved.accountName,
    });

    try {
      await this.bankAccountRepo.save(bankAccount);
    } catch (error) {
      if (
        isUniqueViolation(error, 'UQ_bank_accounts_user_provider_bank_account')
      ) {
        throw new BankAccountAlreadySavedException();
      }
      throw error;
    }

    return toBankAccountResponse(bankAccount);
  }

  // No "default" flag (issue #27) — every saved account is returned,
  // newest first, and a withdrawal request specifies bankAccountId
  // explicitly.
  async listBankAccounts(userId: string): Promise<BankAccountResponseDto[]> {
    const bankAccounts = await this.bankAccountRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return bankAccounts.map(toBankAccountResponse);
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
    const { minAmount, maxAmount, platformFee, providerFee } =
      this.config.withdrawals;
    if (dto.amount < minAmount) {
      throw new WithdrawalAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (dto.amount > maxAmount) {
      throw new WithdrawalAmountTooLargeException(
        Money.of(maxAmount, NGN).toDecimalString(),
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
    const replayResponse = this.resolveWithdrawalReplay(
      replay,
      dto.bankAccountId,
    );
    if (replayResponse) {
      return replayResponse;
    }

    // PIN checked only after a replay match would have short-circuited
    // above — a retried, already-initiated withdrawal shouldn't demand the
    // PIN again, mirroring TransfersService.executeTransfer.
    await this.authService.verifyTransactionPin(userId, dto.pin);

    let posted: PostWithdrawalResult;
    try {
      posted = await this.ledgerService.postWithdrawal({
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
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.ledgerService.checkIdempotentReplay(
          dto.reference,
          userId,
          fingerprint,
        );
        const racedResponse = this.resolveWithdrawalReplay(
          raced,
          dto.bankAccountId,
        );
        if (racedResponse) {
          return racedResponse;
        }
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
    const user = await this.usersService.findById(userId);
    const payoutResult = await this.paymentsService.initiatePayout({
      reference: dto.reference,
      amount,
      bankCode: bankAccount.bankCode,
      accountNumber: bankAccount.accountNumber,
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

    await this.publishWithdrawalInitiatedEvent(posted, bankAccount, user);

    return {
      reference: posted.reference,
      amount: posted.amount.toJSON(),
      platformFee: posted.platformFee.toJSON(),
      providerFee: posted.providerFee.toJSON(),
      status: 'pending',
      createdAt: posted.createdAt.toISOString(),
    };
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
  ): InitiateWithdrawalResponseDto | null {
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
          reference: replay.transaction.reference,
          amount: Money.of(
            replay.transaction.amount,
            replay.transaction.currency,
          ).toJSON(),
          platformFee: metadata.platformFee,
          providerFee: metadata.providerFee,
          status: 'pending',
          createdAt: replay.transaction.createdAt.toISOString(),
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
          accountNumberLast4: bankAccount.accountNumber.slice(-4),
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
