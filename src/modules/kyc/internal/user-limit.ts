import { UserLimit } from '../entities/user-limit.entity';

export const LIMIT_INCREASE_DELAY_MS = 24 * 60 * 60 * 1000;

export interface ResolvedUserLimit {
  limit: bigint | null;
  pending: { amount: bigint; effectiveAt: Date } | null;
}

export function resolveUserLimit(
  row: Pick<
    UserLimit,
    | 'dailyOutflowLimitMinor'
    | 'pendingDailyOutflowLimitMinor'
    | 'pendingEffectiveAt'
  > | null,
  now: Date,
): ResolvedUserLimit {
  if (!row) {
    return { limit: null, pending: null };
  }
  const { pendingDailyOutflowLimitMinor: amount, pendingEffectiveAt } = row;
  if (amount === null || pendingEffectiveAt === null) {
    return { limit: row.dailyOutflowLimitMinor, pending: null };
  }
  if (pendingEffectiveAt <= now) {
    return { limit: amount, pending: null };
  }
  return {
    limit: row.dailyOutflowLimitMinor,
    pending: { amount, effectiveAt: pendingEffectiveAt },
  };
}
