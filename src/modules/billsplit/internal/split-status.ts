import { ShareApiStatus } from '../dto/bill-split-response.dto';

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
