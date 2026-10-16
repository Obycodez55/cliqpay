import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class BvnVerificationFailedException extends DomainException {
  readonly code = 'BVN_VERIFICATION_FAILED';
  constructor() {
    super(
      "We couldn't verify this BVN. Please check the number and try again.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class BvnAlreadyLinkedException extends DomainException {
  readonly code = 'BVN_ALREADY_LINKED';
  constructor() {
    super(
      'This BVN is already linked to another Cliqpay account.',
      HttpStatus.CONFLICT,
    );
  }
}

export class TooManyVerificationAttemptsException extends DomainException {
  readonly code = 'TOO_MANY_VERIFICATION_ATTEMPTS';
  constructor() {
    super(
      'Too many failed verification attempts. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
