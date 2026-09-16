# ADR-0015: Bank account numbers — encrypted ciphertext plus a deterministic hash for uniqueness

**Status:** accepted
**Date:** 2026-09-16

## Context

`docs/architecture.md` §7 requires bank account numbers encrypted at rest.
`bank_accounts.account_number` shipped as a plain `varchar` in Phase 4's
v10 design pass (issue #27) — found during the phase's end-of-phase audit,
not at design or review time.

An AES-256-GCM helper (`encryptSecret`/`decryptSecret`) already existed for
exactly this shape of problem — TOTP secret storage (`mfa.service.ts`) also
needs a value encrypted at rest and recoverable in plaintext, unlike the
one-way hashing used everywhere else for bearer secrets. It lived in
`auth/internal/secrets.util.ts`, not exported, so `withdrawals` couldn't
reach it as-is (`auth`'s internal files aren't a cross-module entry point,
same rule as every other module — docs/architecture.md §10).

Encrypting the column directly breaks something the plaintext column
supported for free: `bank_accounts`' uniqueness constraint,
`(user_id, provider, bank_code, account_number)`, which stops a user
accidentally (or repeatedly) saving the same account. AES-GCM uses a fresh
IV per encryption, so encrypting the same account number twice produces two
different ciphertexts — a unique index on the ciphertext column would never
catch a duplicate.

## Decision

1. Move `encryptSecret`, `decryptSecret`, `encryptionKeyFromHex` out of
   `auth/internal/secrets.util.ts` into a new `src/shared/crypto/secrets.util.ts`.
   They have no auth-specific dependency — `mfa.service.ts` becomes just
   another caller, not the owner. `auth`'s own bearer-token helpers
   (`generateOpaqueToken`, `hashOpaqueToken`, `generateNumericCode`) stay in
   `auth/internal`, since nothing outside `auth` uses them.
2. `bank_accounts.account_number` becomes two columns:
   - `account_number_ciphertext` — the AES-256-GCM value, decrypted only
     where the plaintext is actually needed (returning it in a save/list
     response, handing it to `KoraAdapter.initiatePayout()`).
   - `account_number_hash` — a deterministic, keyed HMAC-SHA256 of the
     plaintext (`hmacHex`, new in the shared crypto util), one-way and never
     decrypted. The uniqueness constraint moves to
     `(user_id, provider, bank_code, account_number_hash)`.
3. `ledger`'s `transactions.metadata` JSON snapshot of the bank account
   (recorded at `postWithdrawal` time, surfaced in withdrawal history) never
   gets the full number either — it's masked to the last 4 digits
   (`maskAccountNumber`, same convention `WithdrawalInitiatedEventPayload`'s
   `accountNumberLast4` already used for the initiated-email notification).
   That JSON blob is at-rest storage too, and has no operational need for
   the full number once the payout call has already been made with it — a
   second plaintext copy sitting outside `bank_accounts`' encrypted column
   would undermine the point of encrypting that column at all.

## Alternatives considered

- **Deterministic encryption of the whole column** (e.g. AES-SIV, or
  AES-GCM with a fixed IV) instead of a separate hash. Rejected — it would
  make the ciphertext itself support the uniqueness check, but at the cost
  of leaking equality across every row (an attacker who compromises the
  database can tell which rows share an account number, even without the
  key). A dedicated one-way hash gives the same uniqueness property without
  that leak, and keeps the recoverable value using an unmodified,
  already-reviewed authenticated encryption scheme.
- **Leave the uniqueness check to application code** (decrypt every one of
  a user's existing rows and compare before insert), dropping the DB
  constraint entirely. Rejected — it trades an atomic, race-free DB
  constraint for a check-then-insert with a real TOCTOU window, for no
  benefit over the hash column.
- **Store the full number in `transactions.metadata` too**, matching what
  `bank_accounts` used to do. Rejected once the ciphertext/plaintext split
  above existed — carrying a second full-plaintext copy in a column with no
  encryption of its own would leave exactly the gap this ADR exists to
  close, just relocated.

## Consequences

- Any future column needing "encrypted, but must support an exact-match
  lookup or uniqueness constraint" has a pattern to follow: ciphertext
  column for the recoverable value, `hmacHex` column for the lookup/
  uniqueness — not bespoke per case.
- `WithdrawalsService` now owns an `encryptionKey` derived at construction
  time, the same shape `MfaService` already had — nothing new architecturally,
  just a second consumer of the same shared primitive.
- A masked account number in `transactions.metadata` means withdrawal
  history can never display more than the last 4 digits from that snapshot.
  If a future feature needs the full number from history (unlikely — the
  live `bank_accounts` row already has it via `GET /withdrawals/bank-accounts`),
  that's a deliberate re-decision, not an oversight to "fix."
