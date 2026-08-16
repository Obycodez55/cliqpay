// A race between an idempotency pre-check and a concurrent insert is
// closed by catching the DB's own unique-constraint rejection, not by
// trying to make the pre-check atomic — every module doing that (payments,
// transfers, notifications) shares this rather than keeping its own copy,
// since it's generic Postgres error classification, not module-owned
// business logic, the same category as runInTransaction in this directory.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}
