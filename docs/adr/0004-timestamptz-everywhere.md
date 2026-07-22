# ADR-0004: Every timestamp column is `timestamptz`, never bare `timestamp`

**Status:** accepted
**Date:** 2026-07-22

## Context

While building issue #5 (email verification), `VerificationCodeService.assertResendAllowed()`'s 60-second resend cooldown started failing intermittently in integration tests: a code issued moments earlier read back as if it had been created a full hour ago. The cause wasn't application logic — it reproduced identically against a real Postgres instance whenever the app process's local timezone wasn't UTC (confirmed under `Africa/Lagos`, UTC+1, a realistic deployment zone for a Nigeria-first product). Every timestamp column shipped through issue #4 (`users.locked_until`/`email_verified_at`/`phone_verified_at`, `sessions.expires_at`/`created_at`/`last_used_at`, `mfa_methods`, `mfa_challenges.expires_at`/`created_at`, `trusted_devices.expires_at`/`created_at`/`last_used_at`), `accounts.created_at`, and `push_tokens.created_at`/`last_used_at` was declared as plain `TIMESTAMP` (no time zone) in its migration, with the matching TypeORM entity using a bare `@Column({ type: 'timestamp' })` / `@CreateDateColumn()` / `@UpdateDateColumn()`.

Postgres's `timestamp without time zone` type stores a naive wall-clock value with no zone attached. node-postgres/TypeORM's round-trip of a JS `Date` through such a column is only correct if the process's local timezone and the value's intended zone agree at both write and read time — which breaks the moment the app runs somewhere other than UTC, silently and systematically, by exactly the host's UTC offset. This isn't cosmetic: `AccountLockedException`'s 15-minute lockout window, every session/trusted-device/MFA-challenge expiry check, and any future comparison of a stored timestamp against `new Date()` all depend on the DB and app clock agreeing.

## Decision

Every timestamp column in this schema is `TIMESTAMPTZ` (`timestamp with time zone`), with no exceptions going forward. `timestamptz` stores an absolute UTC instant regardless of session timezone, so it round-trips correctly through node-postgres/TypeORM independent of the app process's local timezone — this is the standard, supported path; the bug is specific to the zone-less type, not to Postgres or the driver in general.

Fixed via four migrations, one per original table-creation migration (`ConvertUsersAndAccountsTimestamps`, `ConvertSessionsTimestamps`, `ConvertPushTokensTimestamps`, `ConvertMfaAndTrustedDevicesTimestamps`) rather than one combined migration — kept in the same grouping as `CreateUsersAndAccounts`/`CreateSessions`/`CreatePushTokens`/`CreateMfaAndTrustedDevices` so each integration test's partial-schema bootstrap (e.g. `notifications.integration-spec.ts` only ever creates `push_tokens`) can apply exactly the conversion it needs without pulling in unrelated tables it never created. Each `ALTER COLUMN ... TYPE TIMESTAMPTZ USING <col> AT TIME ZONE 'UTC'` interprets the existing naive value as already being UTC — the safe default given there's no production data yet, and the same assumption most CI/cloud environments' default UTC clocks would already make true in practice.

Every entity's `@Column`/`@CreateDateColumn`/`@UpdateDateColumn` decorator for a timestamp field now explicitly declares `{ type: 'timestamptz' }` — never left to default, so a future column can't silently regress back to bare `timestamp` by omission.

## Alternatives considered

- **Leave existing columns as `timestamp`, only use `timestamptz` for new tables (as already done for `verification_codes`)** — rejected. The bug is live in already-shipped tables (login lockout, session/trusted-device/MFA-challenge expiry), not just the new one; leaving it unfixed there means the same class of production incident (Phase 1 auth silently misbehaving on any non-UTC host) stays latent rather than closed.
- **Force the app process to run in UTC (`TZ=UTC`) instead of fixing the columns** — rejected as a workaround, not a fix. It happens to paper over this specific bug but leaves the schema permanently fragile to whichever future process, script, or environment forgets to set it — the correct fix is a column type that doesn't depend on the reader's timezone at all.
- **`USING <col> AT TIME ZONE '<original deployment zone>'` instead of `'UTC'`** — rejected: there's no real production data yet to have a "true" original zone to recover, and every environment this has actually run in (local dev, CI, Testcontainers) either already runs in UTC or, per the very bug this ADR fixes, has an unreliable relationship between stored value and intended zone. Assuming UTC is the least speculative choice.

## Consequences

- Any future timestamp column must be declared `timestamptz` from the start — plain `timestamp` on a new column is a regression of this decision, not a stylistic choice.
- The `USING ... AT TIME ZONE 'UTC'` conversion is a one-way assumption about existing data; if this migration is ever run against an environment with real historical rows written under a non-UTC process clock, those specific rows would carry forward whatever skew they already had rather than being corrected retroactively. Not a concern for the environments this has actually shipped to (dev, CI, Testcontainers), but worth knowing before running this against any environment with real accumulated data.
- Verified against a real Postgres integration test run with `TZ=Africa/Lagos` (see `test/integration/auth.integration-spec.ts`), not just against the machine's default UTC — the whole point of this ADR is a bug that doesn't reproduce under UTC.
