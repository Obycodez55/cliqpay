import { createHash } from 'crypto';
import { signingPart } from '../../../common/device/signed-action';

const MONEY_FIELDS = [
  'amount',
  'interval',
  'nextRunDate',
  'endDate',
  'maxRuns',
] as const;

function part(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    const { unit, count } = value as { unit?: unknown; count?: unknown };
    return `${signingPart(unit)}:${signingPart(count)}`;
  }
  return signingPart(value);
}

export function touchesMoney(body: Record<string, unknown>): boolean {
  return MONEY_FIELDS.some((field) => body[field] !== undefined);
}

// Updates carry no client reference, so the signed `reference` is a digest of
// the money-affecting fields other than amount, which is signed on its own.
export function updateReference(body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      [body.interval, body.nextRunDate, body.endDate, body.maxRuns]
        .map(part)
        .join('|'),
    )
    .digest('hex');
}
