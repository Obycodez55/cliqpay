import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class InvalidCredentialsException extends DomainException {
  readonly code = 'AUTH_INVALID_CREDENTIALS';
  constructor() {
    super('Invalid email or password', HttpStatus.UNAUTHORIZED);
  }
}

export class AccountLockedException extends DomainException {
  readonly code = 'ACCOUNT_LOCKED';
  constructor(lockedUntil: Date) {
    super(
      `Account locked until ${lockedUntil.toISOString()} after too many failed login attempts`,
      HttpStatus.LOCKED,
    );
  }
}

export class InvalidRefreshTokenException extends DomainException {
  readonly code = 'INVALID_REFRESH_TOKEN';
  constructor() {
    super('Invalid refresh token', HttpStatus.UNAUTHORIZED);
  }
}

export class SessionRevokedException extends DomainException {
  readonly code = 'SESSION_REVOKED';
  constructor() {
    super('Session has been revoked', HttpStatus.UNAUTHORIZED);
  }
}

export class MfaChallengeNotFoundException extends DomainException {
  readonly code = 'MFA_CHALLENGE_NOT_FOUND';
  constructor() {
    super('MFA challenge not found', HttpStatus.NOT_FOUND);
  }
}

// Expired or already resolved (verified/failed) — same "don't retry this
// exact resource, get a new one" semantics as 410 elsewhere in REST usage.
export class MfaChallengeInvalidException extends DomainException {
  readonly code = 'MFA_CHALLENGE_INVALID';
  constructor() {
    super(
      'MFA challenge is no longer valid — request a new one',
      HttpStatus.GONE,
    );
  }
}

// Covers both a wrong login-challenge code and a wrong TOTP-confirm code —
// same meaning either way ("the code you gave is wrong"), no need for two
// exception types over one call site each.
export class InvalidMfaCodeException extends DomainException {
  readonly code = 'INVALID_MFA_CODE';
  constructor() {
    super('Invalid MFA code', HttpStatus.UNAUTHORIZED);
  }
}

export class TotpAlreadyEnrolledException extends DomainException {
  readonly code = 'TOTP_ALREADY_ENROLLED';
  constructor() {
    super('TOTP is already active on this account', HttpStatus.CONFLICT);
  }
}

export class NoPendingTotpEnrollmentException extends DomainException {
  readonly code = 'NO_PENDING_TOTP_ENROLLMENT';
  constructor() {
    super(
      'No pending TOTP enrollment to confirm — call enroll first',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class EmailAlreadyVerifiedException extends DomainException {
  readonly code = 'EMAIL_ALREADY_VERIFIED';
  constructor() {
    super('Email address is already verified', HttpStatus.CONFLICT);
  }
}

export class PhoneAlreadyVerifiedException extends DomainException {
  readonly code = 'PHONE_ALREADY_VERIFIED';
  constructor() {
    super('Phone number is already verified', HttpStatus.CONFLICT);
  }
}

// Covers unrecognized, expired, and already-used tokens identically — a
// lookup by hash can't tell them apart.
export class VerificationCodeInvalidException extends DomainException {
  readonly code = 'VERIFICATION_CODE_INVALID';
  constructor() {
    super(
      'This verification link is invalid, expired, or already used',
      HttpStatus.GONE,
    );
  }
}

export class VerificationCodeRateLimitedException extends DomainException {
  readonly code = 'VERIFICATION_CODE_RATE_LIMITED';
  constructor(retryAfterSeconds: number) {
    super(
      `Too many verification codes requested — try again in ${retryAfterSeconds} seconds`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class TransactionPinAlreadySetException extends DomainException {
  readonly code = 'TRANSACTION_PIN_ALREADY_SET';
  constructor() {
    super(
      'A transaction PIN is already set — use change or reset instead',
      HttpStatus.CONFLICT,
    );
  }
}

export class TransactionPinNotSetException extends DomainException {
  readonly code = 'TRANSACTION_PIN_NOT_SET';
  constructor() {
    super('No transaction PIN is set for this account', HttpStatus.NOT_FOUND);
  }
}

export class InvalidTransactionPinException extends DomainException {
  readonly code = 'INVALID_TRANSACTION_PIN';
  constructor() {
    super('Invalid transaction PIN', HttpStatus.UNAUTHORIZED);
  }
}

export class TransactionPinLockedException extends DomainException {
  readonly code = 'TRANSACTION_PIN_LOCKED';
  constructor(lockedUntil: Date) {
    super(
      `Transaction PIN locked until ${lockedUntil.toISOString()} after too many failed attempts`,
      HttpStatus.LOCKED,
    );
  }
}
