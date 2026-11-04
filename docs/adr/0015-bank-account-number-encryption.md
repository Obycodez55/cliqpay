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

## Amendment: a separate key for the lookup hashes

**Date:** 2026-10-22

The lookup hashes (`bank_accounts.account_number_hash`,
`kyc_verifications.bvn_hash`, `kyc_verifications.nin_hash`) were first
computed with `ENCRYPTION_KEY`, the same key as the AES-256-GCM ciphertext.
That meant rotating `ENCRYPTION_KEY` silently invalidated every stored hash
(a previously linked BVN, NIN or bank account could be linked again, with no
error), and one leaked key exposed both the ciphertext and a lookup oracle
over a small keyspace (an 11-digit BVN or NIN).

Every lookup hash now uses `IDENTIFIER_HASH_KEY`: required, 64-hex, validated
in `src/config`, and rejected at startup if it equals `ENCRYPTION_KEY` or
`TRANSACTION_PIN_PEPPER` (case-insensitive). `ENCRYPTION_KEY` is AES only.

**Re-deriving hashes.** The ciphertext is retained next to each hash, so a
hash never needs the old hash key: it is recomputed from the decrypted value.
`pnpm db:rekey-identifier-hashes` (`src/database/rekey-identifier-hashes.ts`)
does this for all three columns. It is a script, not a migration, because
there is no schema change, a fresh database has nothing to do, and a migration
would have to read secrets from the process environment that the integration
contexts inject through config instead. It is also the rotation tool.

- Needs only `DATABASE_URL`, `ENCRYPTION_KEY` and `IDENTIFIER_HASH_KEY`; it
  does not load the application config, so none of the app's other secrets are
  required. It never prints a key, an identifier, ciphertext or a hash, only
  counts and row ids.
- Dry run by default; `--apply` writes. A dry run exits 1 when any hash
  differs from what the current key would produce (or an orphan exists), 0
  when everything is current, so it can gate a deploy.
- One transaction: any abort writes nothing. It aborts on rows that cannot be
  decrypted with `ENCRYPTION_KEY`, on rows that would collide on the new hash,
  and on orphans (hash present, no ciphertext) unless `--allow-orphans`. With
  that flag an orphan is skipped and reported, its stale hash left untouched,
  never nulled: clearing a hash would free that identifier to be linked to
  another account. Rows whose hash is null are skipped.
- Idempotent: re-running changes only rows still out of date.
- The single transaction reads every row into memory, which is fine before
  launch; for large tables it should be chunked by primary key.

**Rotation.**

- `IDENTIFIER_HASH_KEY`: set the new value, deploy, run the script with
  `--apply`, then run it again to repair any rows written in between (it is
  idempotent). Until it has run, lookups use hashes the application can no
  longer match, so the one-per-identity guarantee has a gap; do it in a quiet
  window or pause verification and bank-account saves.
- `ENCRYPTION_KEY`: hashes no longer depend on it, so rotating it only
  re-encrypts the ciphertext columns; see the amendment below.
- `TRANSACTION_PIN_PEPPER` still cannot be rotated (ADR-0009).

## Amendment: rotating ENCRYPTION_KEY

`pnpm db:rotate-encryption-key` (`src/database/rotate-encryption-key.ts`)
re-encrypts every AES-256-GCM column from the old key to a new one:
`mfa_methods.secret_ciphertext`, `bank_accounts.account_number_ciphertext`,
`kyc_verifications.bvn_ciphertext` and `kyc_verifications.nin_ciphertext`. A
unit test greps `src` for `encryptSecret` callers and checks entity metadata
for `*_ciphertext` columns, so a new encrypted column that is not registered
in the script fails the build.

- Reads only `DATABASE_URL`, `OLD_ENCRYPTION_KEY` and `NEW_ENCRYPTION_KEY`
  (64-hex each, must differ); does not load the application config. Output is
  counts and row ids only, never a key, plaintext or ciphertext.
- Dry run by default; `--apply` writes. Exit codes match the re-hash script:
  0 done or dry run clean, 1 dry run found values to rotate, 2 aborted, 3 bad
  configuration.
- One transaction. Each non-null value is decrypted with the old key and
  re-encrypted with the new one. A value that decrypts with the new key and
  not the old is counted as already rotated and left alone, so a re-run is a
  no-op. A value that decrypts with neither aborts the whole run with nothing
  written.
- Like the re-hash script it reads each table into memory in one transaction,
  fine before launch; for large tables it should be chunked by primary key.

**Procedure (maintenance window).** The application has a single
`ENCRYPTION_KEY`, so while data and key disagree it cannot read the values
and any new write would use whichever key it runs with.

1. Generate the new key (`openssl rand -hex 32`); keep the old one.
2. Stop the application and drain workers, so nothing writes ciphertext.
3. Dry run, then apply:
   `OLD_ENCRYPTION_KEY=... NEW_ENCRYPTION_KEY=... DATABASE_URL=... pnpm db:rotate-encryption-key`,
   then the same with `--apply`. A second run should report nothing to
   rotate.
4. Deploy with `ENCRYPTION_KEY` set to the new value and start the
   application.
5. Keep the old key until the application has served traffic on the new one,
   then destroy it. If the script aborts, nothing changed: fix the cause and
   re-run.

`IDENTIFIER_HASH_KEY` is separate and unaffected: the lookup hashes are not
touched by this rotation, and rotating the two keys together is just both
procedures in the same window (run the re-hash script with the new
`IDENTIFIER_HASH_KEY` and the new `ENCRYPTION_KEY` after this one).

**Decision: no dual-key mode.** The application does not accept a primary plus
previous key (`decrypt` trying both, `encrypt` using the primary). That would
remove the maintenance window but adds a second key to config, a decrypt
fallback in every service that reads ciphertext and a window where values are
written under two keys. A primary-plus-previous mode is a possible future
improvement and is not built.
