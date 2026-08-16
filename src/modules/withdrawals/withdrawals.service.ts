import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { PaymentsService } from '../payments/payments.service';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { BankAccount } from './entities/bank-account.entity';
import { SaveBankAccountDto } from './dto/save-bank-account.dto';
import {
  BankAccountResponseDto,
  toBankAccountResponse,
} from './dto/bank-account-response.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import {
  BankAccountAlreadySavedException,
  BankAccountNotResolvableException,
} from './internal/errors';

// Structural, not imported from payments/adapters — that path isn't a
// cross-module entry point (only PaymentsService itself is), same reasoning
// as money-requests.service.ts's own CounterpartyUser type.
type ResolveBankAccountResult = Awaited<
  ReturnType<PaymentsService['resolveBankAccount']>
>;

const PROVIDER = 'kora'; // Same single-active-provider assumption payments.service.ts's fundWallet makes.

/**
 * The one exported surface of the withdrawals module — see
 * docs/architecture.md §10 and ADR-0014. Owns `bank_accounts`; reaches
 * `payments` only for provider resolution and `auth` only for step-up MFA,
 * never `transfers`.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    @InjectRepository(BankAccount)
    private readonly bankAccountRepo: Repository<BankAccount>,
    private readonly authService: AuthService,
    private readonly paymentsService: PaymentsService,
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
}
