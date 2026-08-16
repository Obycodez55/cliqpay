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

// Covers expired, cancelled, declined, and already-paid (via a different
// reference than the one on this attempt — a genuine idempotent replay of
// the *same* reference never reaches this check, see
// MoneyRequestsService.payRequest) uniformly — one message, not four, since
// none of them are a client-actionable distinction beyond "this request
// can't be paid anymore."
export class MoneyRequestNotPayableException extends DomainException {
  readonly code = 'MONEY_REQUEST_NOT_PAYABLE';
  constructor() {
    super(
      'This money request is no longer payable',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
