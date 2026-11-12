export const RISK_WARNING_CODES = [
  'FIRST_PAYMENT_LARGE_AMOUNT',
  'RECIPIENT_NEW_ACCOUNT',
  'RECIPIENT_UNUSUAL_ACTIVITY',
] as const;

export type RiskWarningCode = (typeof RISK_WARNING_CODES)[number];

export const NEW_RECIPIENT_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecipientRiskFacts {
  amountMinor: bigint;
  firstPaymentThresholdMinor: bigint;
  isFirstPayment: boolean;
  recipientCreatedAt: Date;
  recipientHasEnforcedFlag: boolean;
  now: Date;
}

export function recipientRiskWarnings(
  facts: RecipientRiskFacts,
): RiskWarningCode[] {
  const warnings: RiskWarningCode[] = [];
  if (
    facts.isFirstPayment &&
    facts.amountMinor >= facts.firstPaymentThresholdMinor
  ) {
    warnings.push('FIRST_PAYMENT_LARGE_AMOUNT');
  }
  if (
    facts.now.getTime() - facts.recipientCreatedAt.getTime() <
    NEW_RECIPIENT_ACCOUNT_AGE_MS
  ) {
    warnings.push('RECIPIENT_NEW_ACCOUNT');
  }
  if (facts.recipientHasEnforcedFlag) {
    warnings.push('RECIPIENT_UNUSUAL_ACTIVITY');
  }
  return warnings;
}
