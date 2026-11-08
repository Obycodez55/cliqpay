export const SCHEDULED_PAYMENT_SWEEP_QUEUE = 'scheduled-payment-sweep';
export const SCHEDULED_PAYMENT_RUNS_QUEUE = 'scheduled-payment-runs';

export interface RunJobData {
  runId: string;
}

// BullMQ rejects a custom job id with exactly one ':', so the parts are joined
// with '_', as in the attempt reference. The attempt number keeps a retry from
// colliding with the previous attempt's job while BullMQ still holds it.
export function runJobId(
  scheduleId: string,
  runNumber: number,
  attemptNumber: number,
): string {
  return `${scheduleId}_${runNumber}_${attemptNumber}`;
}
