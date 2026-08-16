// Was duplicated identically in payments/internal/errors.ts and
// transfers/internal/errors.ts (Phase 3 end-of-phase audit) — both modules
// need it for the same reason (a race between an idempotency pre-check and
// a concurrent insert is closed by catching the DB's own unique-constraint
// rejection, not by trying to make the pre-check atomic), and neither is a
// peripheral module the other can't depend on — this is generic Postgres
// error classification, the same category as runInTransaction in this
// directory, not module-owned business logic.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}
