import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class InsufficientFundsException extends DomainException {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super(
      'Insufficient funds to complete this transfer',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
