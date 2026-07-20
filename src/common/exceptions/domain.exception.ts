import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base for business-rule violations raised deliberately by a module's
 * service layer (e.g. InsufficientFundsException, TierLimitExceededException)
 * — as opposed to framework-level errors (validation, 404s) or genuinely
 * unexpected exceptions. The global exception filter tags these distinctly
 * in logs and responses so "the ledger rejected this on purpose" is never
 * confused with "something broke."
 */
export abstract class DomainException extends HttpException {
  abstract readonly code: string;

  protected constructor(message: string, status: HttpStatus) {
    super(message, status);
  }
}
