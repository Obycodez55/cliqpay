import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

export const ApiRiskAcknowledgementRequired = () =>
  applyDecorators(
    ApiResponse({
      status: 422,
      description:
        'RISK_ACKNOWLEDGEMENT_REQUIRED: `error.code` is `RISK_ACKNOWLEDGEMENT_REQUIRED` and `error.details.warnings` lists the warning codes: `FIRST_PAYMENT_LARGE_AMOUNT` (first payment to this recipient at or above the configured threshold), `RECIPIENT_NEW_ACCOUNT` (recipient account under 7 days old), `RECIPIENT_UNUSUAL_ACTIVITY` (we have seen unusual activity on the recipient account). Nothing was recorded. Show the warnings, then resend the same request with the same `reference` and device signature plus `riskAcknowledged: true`. A repeat of a completed reference returns the original result with no warnings.',
    }),
  );
