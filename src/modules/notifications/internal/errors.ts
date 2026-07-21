import { UnrecoverableError } from 'bullmq';

/**
 * Shared retryable/non-retryable split used by the HTTP-based real adapters
 * (Brevo, Termii): timeouts, connection errors, 5xx, and 429 are transient
 * and get BullMQ's normal retry/backoff; anything else (malformed recipient,
 * other 4xx) can never succeed on retry, so it stops the job immediately.
 */
export function classifyHttpFailure(
  status: number | undefined,
  message: string,
): never {
  if (status === undefined || status === 429 || status >= 500) {
    throw new Error(message);
  }
  throw new UnrecoverableError(message);
}

/**
 * Fake adapters are logging stand-ins that always "succeed" by default —
 * but retry-classification and end-to-end tests need a deterministic way to
 * make them fail without a live provider. A recipient/token containing one
 * of these sentinels throws the corresponding error type instead of
 * sending, e.g. "user+fail-permanent@example.com" or a push token literally
 * containing "fail-transient".
 */
export function maybeThrowSentinelFailure(
  recipient: string,
  providerName: string,
): void {
  if (recipient.includes('fail-permanent')) {
    throw new UnrecoverableError(
      `${providerName}: recipient marked permanently invalid (test sentinel)`,
    );
  }
  if (recipient.includes('fail-transient')) {
    throw new Error(
      `${providerName}: simulated transient failure (test sentinel)`,
    );
  }
}
