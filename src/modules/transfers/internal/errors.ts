import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class SelfTransferException extends DomainException {
  readonly code = 'SELF_TRANSFER_NOT_ALLOWED';
  constructor() {
    super('You cannot send money to yourself', HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class TransferAmountTooSmallException extends DomainException {
  readonly code = 'TRANSFER_AMOUNT_TOO_SMALL';
  constructor(minAmount: string) {
    super(
      `Transfer amount is below the minimum of ${minAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class TransferAmountTooLargeException extends DomainException {
  readonly code = 'TRANSFER_AMOUNT_TOO_LARGE';
  constructor(maxAmount: string) {
    super(
      `Transfer amount exceeds the maximum of ${maxAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class SenderEmailNotVerifiedException extends DomainException {
  readonly code = 'SENDER_EMAIL_NOT_VERIFIED';
  constructor() {
    super(
      'Your email must be verified before you can send money',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class UnsupportedTransferCurrencyException extends DomainException {
  readonly code = 'UNSUPPORTED_TRANSFER_CURRENCY';
  constructor() {
    super(
      'Transfers are only supported in NGN at this time',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class RecipientWalletNotFoundException extends DomainException {
  readonly code = 'RECIPIENT_WALLET_NOT_FOUND';
  constructor() {
    super('Recipient wallet not found', HttpStatus.NOT_FOUND);
  }
}

export class SelfMoneyRequestException extends DomainException {
  readonly code = 'SELF_MONEY_REQUEST_NOT_ALLOWED';
  constructor() {
    super(
      'You cannot request money from yourself',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class MoneyRequestAmountTooSmallException extends DomainException {
  readonly code = 'MONEY_REQUEST_AMOUNT_TOO_SMALL';
  constructor(minAmount: string) {
    super(
      `Requested amount is below the minimum of ${minAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class MoneyRequestAmountTooLargeException extends DomainException {
  readonly code = 'MONEY_REQUEST_AMOUNT_TOO_LARGE';
  constructor(maxAmount: string) {
    super(
      `Requested amount exceeds the maximum of ${maxAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class PayerNotFoundException extends DomainException {
  readonly code = 'PAYER_NOT_FOUND';
  constructor() {
    super('Payer not found', HttpStatus.NOT_FOUND);
  }
}

export class MoneyRequestPairCapExceededException extends DomainException {
  readonly code = 'MONEY_REQUEST_PAIR_CAP_EXCEEDED';
  constructor(maxPendingPerPair: number) {
    super(
      `You already have ${maxPendingPerPair} outstanding requests to this user`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// Covers "doesn't exist", "belongs to someone else", and "no longer
// effectively pending" alike — the query that looks it up scopes on all
// three at once (see MoneyRequestsService), so none of them are
// distinguishable from outside, which is the point (IDOR discipline, same
// as notifications' markRead).
export class MoneyRequestNotFoundException extends DomainException {
  readonly code = 'MONEY_REQUEST_NOT_FOUND';
  constructor() {
    super(
      'Money request not found or no longer actionable',
      HttpStatus.NOT_FOUND,
    );
  }
}

// `transfers` (core) can't reuse another module's copy of this — see
// payments/internal/errors.ts's own comment on the same convention. Used
// when two concurrent sendMoney() calls for the same `reference` both miss
// the idempotency pre-check and both try to post.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}
