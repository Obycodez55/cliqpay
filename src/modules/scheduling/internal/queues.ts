export const SCHEDULED_PAYMENT_SWEEP_QUEUE = 'scheduled-payment-sweep';
export const SCHEDULED_PAYMENT_RUNS_QUEUE = 'scheduled-payment-runs';

export interface RunJobData {
  runId: string;
}

// BullMQ rejects a custom job id with exactly one ':', so the schedule id and
// run number are joined with '_', as in the attempt reference.
export function runJobId(scheduleId: string, runNumber: number): string {
  return `${scheduleId}_${runNumber}`;
}
