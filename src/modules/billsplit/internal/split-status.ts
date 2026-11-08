import {
  BillSplitApiStatus,
  ShareApiStatus,
} from '../dto/bill-split-response.dto';

export type SplitOutcome = 'completed' | 'closed';

export function deriveOutcome(
  shareStatuses: readonly ShareApiStatus[],
): SplitOutcome | null {
  if (shareStatuses.every((status) => status === 'paid')) {
    return 'completed';
  }
  const settled = shareStatuses.every(
    (status) =>
      status === 'paid' || status === 'declined' || status === 'cancelled',
  );
  return settled ? 'closed' : null;
}

export function deriveSplitStatus(
  split: { cancelledAt: Date | null; expiresAt: Date },
  shareStatuses: readonly ShareApiStatus[],
  now: Date,
): BillSplitApiStatus {
  if (split.cancelledAt) {
    return 'cancelled';
  }
  const outcome = deriveOutcome(shareStatuses);
  if (outcome) {
    return outcome;
  }
  return now > split.expiresAt ? 'expired' : 'open';
}
