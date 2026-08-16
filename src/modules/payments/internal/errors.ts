// Payments (core) can't reuse notifications' sentinel/retry-classification
// helpers — they live in a peripheral module, off-limits per the module
// boundary rules (docs/architecture.md §10). Small and module-local by
// design, same as every other module's own internal/errors.ts.

// FakeAdapter's deterministic, configurable-failure equivalent of the
// email/sms adapters' "fail-permanent"/"fail-transient" sentinel convention
// (notifications/internal/errors.ts) — a `reference` containing this
// substring fails initiatePayment() instead of succeeding, so tests can
// exercise the failure path without a live Kora sandbox.
export function maybeThrowFakePaymentFailure(reference: string): void {
  if (reference.includes('fail')) {
    throw new Error(
      'FakeAdapter: simulated payment initiation failure (test sentinel)',
    );
  }
}
