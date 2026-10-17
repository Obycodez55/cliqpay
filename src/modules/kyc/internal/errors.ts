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

export class NinVerificationFailedException extends DomainException {
  readonly code = 'NIN_VERIFICATION_FAILED';
  constructor() {
    super(
      "We couldn't verify this NIN. Please check the number and try again.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class NinAlreadyLinkedException extends DomainException {
  readonly code = 'NIN_ALREADY_LINKED';
  constructor() {
    super(
      'This NIN is already linked to another Cliqpay account.',
      HttpStatus.CONFLICT,
    );
  }
}

export class BvnAlreadyVerifiedException extends DomainException {
  readonly code = 'BVN_ALREADY_VERIFIED';
  constructor() {
    super(
      'A BVN is already verified on this account. Contact support to change it.',
      HttpStatus.CONFLICT,
    );
  }
}

export class NinAlreadyVerifiedException extends DomainException {
  readonly code = 'NIN_ALREADY_VERIFIED';
  constructor() {
    super(
      'A NIN is already verified on this account. Contact support to change it.',
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
