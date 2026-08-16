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

// `transfers` (core) can't reuse another module's copy of this — see
// payments/internal/errors.ts's own comment on the same convention. Used
// when two concurrent sendMoney() calls for the same `reference` both miss
// the idempotency pre-check and both try to post.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}
