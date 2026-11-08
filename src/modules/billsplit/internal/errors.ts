import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class BillSplitNotFoundException extends DomainException {
  readonly code = 'BILL_SPLIT_NOT_FOUND';
  constructor() {
    super('Bill split not found', HttpStatus.NOT_FOUND);
  }
}

export class BillSplitParticipantsInvalidException extends DomainException {
  readonly code = 'BILL_SPLIT_PARTICIPANTS_INVALID';
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class BillSplitSharesInvalidException extends DomainException {
  readonly code = 'BILL_SPLIT_SHARES_INVALID';
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class BillSplitShareTooSmallException extends DomainException {
  readonly code = 'BILL_SPLIT_SHARE_TOO_SMALL';
  constructor(minAmount: string) {
    super(
      `Every participant's share must be at least ${minAmount}; this split would produce a smaller one`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class BillSplitReferenceReusedException extends DomainException {
  readonly code = 'BILL_SPLIT_REFERENCE_REUSED';
  constructor() {
    super(
      'This reference was already used for a different bill split — use a new reference.',
      HttpStatus.CONFLICT,
    );
  }
}

export class BillSplitNotOpenException extends DomainException {
  readonly code = 'BILL_SPLIT_NOT_OPEN';
  constructor() {
    super('Only an open bill split can be cancelled', HttpStatus.CONFLICT);
  }
}
