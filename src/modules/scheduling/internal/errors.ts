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
      `You can have at most ${maxActive} active scheduled payments`,
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
