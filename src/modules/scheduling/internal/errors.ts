import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class ScheduledPaymentNotFoundException extends DomainException {
  readonly code = 'SCHEDULED_PAYMENT_NOT_FOUND';
  constructor() {
    super('Scheduled payment not found', HttpStatus.NOT_FOUND);
  }
}

export class ScheduleReferenceReusedException extends DomainException {
  readonly code = 'SCHEDULE_REFERENCE_REUSED';
  constructor() {
    super(
      'This reference was already used for a different scheduled payment — use a new reference.',
      HttpStatus.CONFLICT,
    );
  }
}

export class ScheduleStartDateInvalidException extends DomainException {
  readonly code = 'SCHEDULE_START_DATE_INVALID';
  constructor(min: string, max: string) {
    super(
      `startDate must be a real date between ${min} and ${max}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class ScheduleAmountExceedsDailyLimitException extends DomainException {
  readonly code = 'SCHEDULE_AMOUNT_EXCEEDS_DAILY_LIMIT';
  constructor(dailyLimit: string) {
    super(
      `A scheduled payment can be at most your daily limit of ${dailyLimit}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleLimitReachedException extends DomainException {
  readonly code = 'SCHEDULE_LIMIT_REACHED';
  constructor(maxActive: number) {
    super(
      `You can have at most ${maxActive} active or paused scheduled payments`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleRecipientUnableToReceiveException extends DomainException {
  readonly code = 'RECIPIENT_UNABLE_TO_RECEIVE';
  constructor() {
    super(
      "This recipient can't receive this amount right now.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleSenderFrozenException extends DomainException {
  readonly code = 'SENDER_ACCOUNT_FROZEN';
  constructor() {
    super(
      'Your account is frozen and cannot send money right now',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ScheduleAlreadyCompletedException extends DomainException {
  readonly code = 'SCHEDULE_ALREADY_COMPLETED';
  constructor() {
    super(
      'This scheduled payment has already run and cannot be cancelled',
      HttpStatus.CONFLICT,
    );
  }
}

export class ScheduleRecurrenceInvalidException extends DomainException {
  readonly code = 'SCHEDULE_RECURRENCE_INVALID';
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class ScheduleStatusConflictException extends DomainException {
  readonly code = 'SCHEDULE_STATUS_CONFLICT';
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
  }
}

export class ScheduleNothingToResumeException extends DomainException {
  readonly code = 'SCHEDULE_NOTHING_TO_RESUME';
  constructor() {
    super(
      'This scheduled payment has no run left to start, so it cannot be resumed. You can cancel it.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleNextRunDateInvalidException extends DomainException {
  readonly code = 'SCHEDULE_NEXT_RUN_DATE_INVALID';
  constructor(min: string, max: string) {
    super(
      `nextRunDate must be a real date between ${min} and ${max}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class SchedulePinRequiredException extends DomainException {
  readonly code = 'SCHEDULE_PIN_REQUIRED';
  constructor() {
    super(
      'Changing the amount, interval, next run date or end condition needs your PIN',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class ScheduleNextRunDateRequiredException extends DomainException {
  readonly code = 'SCHEDULE_NEXT_RUN_DATE_REQUIRED';
  constructor() {
    super(
      'A paused scheduled payment has no next run date, so changing its interval needs a nextRunDate too',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleNoUpcomingRunException extends DomainException {
  readonly code = 'SCHEDULE_NO_UPCOMING_RUN';
  constructor() {
    super(
      'This scheduled payment has no upcoming run to move or re-time',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleEditLeavesNoRunException extends DomainException {
  readonly code = 'SCHEDULE_EDIT_LEAVES_NO_RUN';
  constructor() {
    super(
      'This change would leave no run to start. Cancel the scheduled payment instead.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleBankAccountNotFoundException extends DomainException {
  readonly code = 'BANK_ACCOUNT_NOT_FOUND';
  constructor() {
    super('Bank account not found', HttpStatus.NOT_FOUND);
  }
}

export class ScheduleAmountTooSmallException extends DomainException {
  readonly code = 'WITHDRAWAL_AMOUNT_TOO_SMALL';
  constructor(minAmount: string) {
    super(
      `Withdrawal amount is below the minimum of ${minAmount}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleSenderEmailNotVerifiedException extends DomainException {
  readonly code = 'SENDER_EMAIL_NOT_VERIFIED';
  constructor() {
    super(
      'Your email must be verified before you can send money',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ScheduleTargetInvalidException extends DomainException {
  readonly code = 'SCHEDULE_TARGET_INVALID';
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST);
  }
}
