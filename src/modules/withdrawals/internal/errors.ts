import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class BankAccountNotResolvableException extends DomainException {
  readonly code = 'BANK_ACCOUNT_NOT_RESOLVABLE';
  constructor() {
    super(
      "We couldn't verify this bank account. Please check the bank and account number and try again.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class BankAccountAlreadySavedException extends DomainException {
  readonly code = 'BANK_ACCOUNT_ALREADY_SAVED';
  constructor() {
    super('This bank account has already been saved.', HttpStatus.CONFLICT);
  }
}

export class BankAccountNotFoundException extends DomainException {
  readonly code = 'BANK_ACCOUNT_NOT_FOUND';
  constructor() {
    super('Bank account not found', HttpStatus.NOT_FOUND);
  }
}

export class WithdrawalAmountTooSmallException extends DomainException {
  readonly code = 'WITHDRAWAL_AMOUNT_TOO_SMALL';
  constructor(minAmount: string) {
    super(
      `Withdrawal amount is below the minimum of ${minAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class WithdrawalAmountTooLargeException extends DomainException {
  readonly code = 'WITHDRAWAL_AMOUNT_TOO_LARGE';
  constructor(maxAmount: string) {
    super(
      `Withdrawal amount exceeds the maximum of ${maxAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// Defensive only, mirroring TransfersService's UnsupportedTransferCurrencyException
// — no currency field exists on the DTO today, so this can't be reached
// through the real API until multi-currency wallets (Phase 10) exist.
export class UnsupportedWithdrawalCurrencyException extends DomainException {
  readonly code = 'UNSUPPORTED_WITHDRAWAL_CURRENCY';
  constructor() {
    super(
      'Withdrawals are only supported in NGN at this time',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// The payout was rejected synchronously by the provider (or the provider
// call failed outright) after the debit had already posted — by the time
// this is thrown, LedgerService.reverseWithdrawal has already put the money
// back, so the message says so rather than leaving the client to guess.
export class WithdrawalPayoutFailedException extends DomainException {
  readonly code = 'WITHDRAWAL_PAYOUT_FAILED';
  constructor(reason: string) {
    super(
      `Withdrawal could not be processed (${reason}) — the amount has been returned to your wallet.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
