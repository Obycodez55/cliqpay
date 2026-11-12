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

export class FraudFlagHasOpenScamCasesException extends DomainException {
  readonly code = 'FRAUD_FLAG_HAS_OPEN_SCAM_CASES';
  constructor() {
    super(
      'This flag stands for scam cases that are still open; decide those first',
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

export class ScamCaseNotFoundException extends DomainException {
  readonly code = 'SCAM_CASE_NOT_FOUND';
  constructor() {
    super('No scam case found for the given reference', HttpStatus.NOT_FOUND);
  }
}

export class ScamCaseAlreadyDecidedException extends DomainException {
  readonly code = 'SCAM_CASE_ALREADY_DECIDED';
  constructor() {
    super(
      'This case has already been decided and cannot be changed',
      HttpStatus.CONFLICT,
    );
  }
}

export class ScamReportTransferNotFoundException extends DomainException {
  readonly code = 'SCAM_REPORT_TRANSFER_NOT_FOUND';
  constructor() {
    super('No transfer you sent matches the given id', HttpStatus.NOT_FOUND);
  }
}

export class ScamReportNotReportableException extends DomainException {
  readonly code = 'SCAM_REPORT_NOT_REPORTABLE';
  constructor() {
    super(
      'Only a completed transfer to another Cliqpay user can be reported',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScamReportWindowExpiredException extends DomainException {
  readonly code = 'SCAM_REPORT_WINDOW_EXPIRED';
  constructor() {
    super(
      'This transfer is more than 30 days old and can no longer be reported here. Contact support.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScamReportAlreadyFiledException extends DomainException {
  readonly code = 'SCAM_REPORT_ALREADY_FILED';
  constructor() {
    super('This transfer has already been reported', HttpStatus.CONFLICT);
  }
}
