import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class EmailAlreadyRegisteredException extends DomainException {
  readonly code = 'EMAIL_ALREADY_REGISTERED';
  constructor() {
    super('An account with this email already exists', HttpStatus.CONFLICT);
  }
}

export class UsernameAlreadyTakenException extends DomainException {
  readonly code = 'USERNAME_ALREADY_TAKEN';
  constructor() {
    super('This username is already taken', HttpStatus.CONFLICT);
  }
}

export class PhoneAlreadyRegisteredException extends DomainException {
  readonly code = 'PHONE_ALREADY_REGISTERED';
  constructor() {
    super(
      'An account with this phone number already exists',
      HttpStatus.CONFLICT,
    );
  }
}

// Username is a payment-routing address (Phase 3 sends money "by username or
// email") — the 30-day cooldown in UsersService.changeUsername stops it
// churning out from under anyone who saved it to pay later.
export class UsernameChangeCooldownException extends DomainException {
  readonly code = 'USERNAME_CHANGE_COOLDOWN';
  constructor(nextAllowedAt: Date) {
    super(
      `Username can only be changed once every 30 days — next change allowed at ${nextAllowedAt.toISOString()}`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// Reachable if a code for some other `email_verification`-purpose flow
// (e.g. a stale signup-verification link, same purpose) gets submitted to
// change-email/confirm instead — the code consumes fine (it's a real,
// unused, unexpired code for this user) but there's no pending change to
// apply.
export class NoPendingEmailChangeException extends DomainException {
  readonly code = 'NO_PENDING_EMAIL_CHANGE';
  constructor() {
    super(
      'No pending email change to confirm — start with change-email first',
      HttpStatus.NOT_FOUND,
    );
  }
}

// Reachable if a code for some other `phone_verification`-purpose flow
// (e.g. a stale signup-verification code, same purpose) gets submitted to
// change-phone/confirm instead — the code consumes fine (it's a real,
// unused, unexpired code for this user) but there's no pending change to
// apply. Mirrors NoPendingEmailChangeException.
export class NoPendingPhoneChangeException extends DomainException {
  readonly code = 'NO_PENDING_PHONE_CHANGE';
  constructor() {
    super(
      'No pending phone change to confirm — start with change-phone first',
      HttpStatus.NOT_FOUND,
    );
  }
}

const CONSTRAINT_EXCEPTIONS: Record<string, () => DomainException> = {
  UQ_users_email: () => new EmailAlreadyRegisteredException(),
  UQ_users_username: () => new UsernameAlreadyTakenException(),
  UQ_users_phone: () => new PhoneAlreadyRegisteredException(),
};

/**
 * Maps a Postgres unique-violation (23505) on `users` to the specific
 * domain exception for whichever field collided — inserting and catching
 * the DB constraint is race-free by construction, unlike a pre-check
 * findOne (see users.service.ts).
 */
export function mapUsersUniqueViolation(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  const exceptionFactory =
    pgError?.code === '23505' && pgError.constraint
      ? CONSTRAINT_EXCEPTIONS[pgError.constraint]
      : undefined;
  if (exceptionFactory) {
    throw exceptionFactory();
  }
  throw error;
}
