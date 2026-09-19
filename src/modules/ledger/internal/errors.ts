import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class InsufficientFundsException extends DomainException {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super(
      'Insufficient funds to complete this transaction',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// §4.2/ADR-0016: partial chargebacks are allowed, capped at the original
// transaction's own amount minus whatever has already been charged back
// against it. Enforced inside postChargeback's locked section, not by a
// caller's own pre-check — the original transaction row is already locked
// there for the status flip, so this is the one place that can validate the
// cap without a check-then-lock race (CLAUDE.md).
export class ChargebackAmountExceedsRemainingException extends DomainException {
  readonly code = 'CHARGEBACK_AMOUNT_EXCEEDS_REMAINING';
  constructor(remaining: string) {
    super(
      `Chargeback amount exceeds the remaining chargebackable balance of ${remaining}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
