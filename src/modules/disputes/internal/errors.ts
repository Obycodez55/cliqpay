import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class DuplicateDisputeReferenceException extends DomainException {
  readonly code = 'DUPLICATE_DISPUTE_REFERENCE';
  constructor() {
    super(
      'This dispute reference has already been recorded — it will not be posted again.',
      HttpStatus.CONFLICT,
    );
  }
}

export class OriginalTransactionNotFoundException extends DomainException {
  readonly code = 'ORIGINAL_TRANSACTION_NOT_FOUND';
  constructor() {
    super(
      'No funding transaction found for the given reference',
      HttpStatus.NOT_FOUND,
    );
  }
}

// Reachable if the referenced transaction never completed (pending/failed)
// or was already reversed — none of those represent money the bank could
// legitimately have clawed back.
export class OriginalTransactionNotDisputableException extends DomainException {
  readonly code = 'ORIGINAL_TRANSACTION_NOT_DISPUTABLE';
  constructor() {
    super(
      'This transaction is not in a state that can be charged back',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class DisputeNotFoundException extends DomainException {
  readonly code = 'DISPUTE_NOT_FOUND';
  constructor() {
    super('No dispute found for the given reference', HttpStatus.NOT_FOUND);
  }
}

// Reachable for a dispute already 'resolved' or 'upheld' — a dispute
// resolves exactly once (issue #36).
export class DisputeAlreadyResolvedException extends DomainException {
  readonly code = 'DISPUTE_ALREADY_RESOLVED';
  constructor() {
    super(
      'This dispute has already been resolved and cannot be resolved again',
      HttpStatus.CONFLICT,
    );
  }
}

// Resolution always reverses the full recorded chargeback amount, never a
// partial one — this is the request-time confirmation of that, checked
// against the dispute's own row (issue #36).
export class DisputeResolutionAmountMismatchException extends DomainException {
  readonly code = 'DISPUTE_RESOLUTION_AMOUNT_MISMATCH';
  constructor(expectedAmount: string) {
    super(
      `Resolution amount must match the dispute's recorded amount (${expectedAmount})`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
