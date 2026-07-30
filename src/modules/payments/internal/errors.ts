// Payments (core) can't reuse notifications' sentinel/retry-classification
// helpers — they live in a peripheral module, off-limits per the module
// boundary rules (docs/architecture.md §10). Small and module-local by
// design, same as every other module's own internal/errors.ts.

// Mirrors mapUsersUniqueViolation's pgError.code check (users/internal/errors.ts)
// — inserting and catching the DB constraint is race-free by construction,
// unlike a pre-check findOne. Used when two concurrent fundWallet() calls
// for the same `reference` both miss the pre-check and both try to insert.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

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
