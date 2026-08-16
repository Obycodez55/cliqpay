import { BadRequestException } from '@nestjs/common';

// Shared by any list endpoint keyed on (createdAt, id) DESC — ledger's
// transaction history and notifications' list are the two callers today.
// Same encoding, same tie-break shape, same 400-on-malformed behavior for
// both, so cursors behave consistently across the API.
export interface CreatedAtIdCursor {
  createdAt: string;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCreatedAtIdCursor(cursor: CreatedAtIdCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

// A corrupted/forged cursor must 400, not reach the DB query.
export function decodeCreatedAtIdCursor(raw: string): CreatedAtIdCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const candidate = parsed as Partial<CreatedAtIdCursor> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.id !== 'string' ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    !UUID_RE.test(candidate.id)
  ) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt: candidate.createdAt, id: candidate.id };
}
