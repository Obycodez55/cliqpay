import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class FraudFlagNotFoundException extends DomainException {
  readonly code = 'FRAUD_FLAG_NOT_FOUND';
  constructor() {
    super('No fraud flag found for the given id', HttpStatus.NOT_FOUND);
  }
}

export class FraudFlagAlreadyResolvedException extends DomainException {
  readonly code = 'FRAUD_FLAG_ALREADY_RESOLVED';
  constructor() {
    super(
      'This flag cannot move to the requested status from its current one',
      HttpStatus.CONFLICT,
    );
  }
}

export class RestrictionNotLiftableException extends DomainException {
  readonly code = 'RESTRICTION_NOT_LIFTABLE';
  constructor(reason: string) {
    super(
      `A "${reason}" restriction is lifted through its own process, not here`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class RestrictionNotFoundException extends DomainException {
  readonly code = 'RESTRICTION_NOT_FOUND';
  constructor() {
    super(
      'No open restriction matches the given user, reason and source',
      HttpStatus.NOT_FOUND,
    );
  }
}
