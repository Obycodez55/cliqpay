import {
  FAILURE_CODES,
  FailureCode,
} from '../entities/scheduled-payment-attempt.entity';

export const RECIPIENT_UNABLE_TO_RECEIVE = 'recipient_unable_to_receive';

const RECIPIENT_SIDE: readonly string[] = [
  'blocked',
  'recipient_cap',
  'recipient_unavailable',
];

export const CLIENT_FAILURE_CODES = [
  ...FAILURE_CODES.filter((code) => !RECIPIENT_SIDE.includes(code)),
  RECIPIENT_UNABLE_TO_RECEIVE,
] as const;
export type ClientFailureCode = (typeof CLIENT_FAILURE_CODES)[number];

// The live send path answers a block, the recipient's cap and a missing
// recipient identically, so a schedule can't tell the sender which it was.
// The precise code stays in the database.
export function toClientFailureReason(reason: string): string {
  return RECIPIENT_SIDE.includes(reason) ? RECIPIENT_UNABLE_TO_RECEIVE : reason;
}

export function toClientFailureCode(
  code: FailureCode | null,
): ClientFailureCode | null {
  return code === null
    ? null
    : (toClientFailureReason(code) as ClientFailureCode);
}
