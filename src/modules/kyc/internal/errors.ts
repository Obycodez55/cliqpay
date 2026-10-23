import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { Money } from '../../../shared/primitives/money';

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

export class LivenessInProgressException extends DomainException {
  readonly code = 'LIVENESS_IN_PROGRESS';
  constructor() {
    super(
      'A liveness check is already being processed for this account. Please wait for its result.',
      HttpStatus.CONFLICT,
    );
  }
}

export class IdentityMismatchException extends DomainException {
  readonly code = 'IDENTITY_MISMATCH';
  constructor(verifying: 'bvn' | 'nin') {
    const [thisId, otherId] =
      verifying === 'bvn' ? ['BVN', 'NIN'] : ['NIN', 'BVN'];
    super(
      `This ${thisId} doesn't match the ${otherId} already verified on your account.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
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

export class KycVerificationRequiredException extends DomainException {
  readonly code = 'KYC_VERIFICATION_REQUIRED';
  constructor(
    message = 'Verify your BVN or NIN to start sending, withdrawing or adding money.',
  ) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class DailyLimitExceededException extends DomainException {
  readonly code = 'DAILY_LIMIT_EXCEEDED';
  readonly details: { dailyLimit: object; remaining: object };
  constructor(dailyLimit: Money, remaining: Money) {
    super(
      `This would exceed your daily limit of ${dailyLimit.toDecimalString()}. You have ${remaining.toDecimalString()} left today.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    this.details = {
      dailyLimit: dailyLimit.toJSON(),
      remaining: remaining.toJSON(),
    };
  }
}

export class BalanceCapExceededException extends DomainException {
  readonly code = 'BALANCE_CAP_EXCEEDED';
  readonly details: { balanceCap: object; remaining: object };
  constructor(
    balanceCap: Money,
    remaining: Money,
    message = `This top-up would take your wallet over its balance limit of ${balanceCap.toDecimalString()}. You can add up to ${remaining.toDecimalString()} right now, counting any top-ups still in progress.`,
  ) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY);
    this.details = {
      balanceCap: balanceCap.toJSON(),
      remaining: remaining.toJSON(),
    };
  }
}

export class RecipientCannotReceiveException extends DomainException {
  readonly code = 'RECIPIENT_UNABLE_TO_RECEIVE';
  constructor() {
    super(
      "This recipient can't receive this amount right now.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class TierLimitNotConfiguredException extends DomainException {
  readonly code = 'TIER_LIMIT_NOT_CONFIGURED';
  constructor() {
    super(
      'Transaction limits are not configured for this account.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
