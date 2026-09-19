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

// §4.2: partial chargebacks are allowed, capped at original_net_amount minus
// whatever has already been charged back against the same transaction.
export class ChargebackAmountExceedsRemainingException extends DomainException {
  readonly code = 'CHARGEBACK_AMOUNT_EXCEEDS_REMAINING';
  constructor(remaining: string) {
    super(
      `Chargeback amount exceeds the remaining chargebackable balance of ${remaining}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
