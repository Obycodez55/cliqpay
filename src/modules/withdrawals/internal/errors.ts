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
