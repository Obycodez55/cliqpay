# ADR-0009: Transaction PIN — peppered 4-digit, with lockout state separate from login's

**Status:** accepted
**Date:** 2026-08-01

## Context

`credentials.transaction_pin_hash` has existed since Phase 1, set to `null`
at registration and never written since — docs/architecture.md §6 Phase 1
added it "structurally even though it's not enforced until Phase 3/4."
Phase 3 is where it starts mattering: a P2P transfer is the first
user-initiated debit out of a wallet, where funding only ever credits one.

Two things needed deciding before the column could be used.

**Entropy.** A transaction PIN is not a password. Every banking app in this
market (Opay, Kuda, PalmPay) uses 4 digits, and that expectation is strong
enough that deviating from it is a real UX cost. But 4 digits is 10,000
candidates: bcrypt at the cost factor already used for passwords cracks the
entire space for one account in under ten minutes. In a database leak the
PIN would be the weakest secret in the file, and the one still standing
after a weak password falls.

**Lockout state.** Phase 1 already has `failed_login_attempts` /
`locked_until` on the same table, at 5 attempts / 15 minutes. Reusing them
for PIN failures looks like consolidation and is actually a denial-of-service
against the account owner: someone guessing PINs on a stolen session would
lock the real user out of *login* — and login is precisely what that user
needs in order to reset the PIN and evict the attacker. The attack would
disable its own remedy.

## Decision

**Format.** 4 digits. Rejected at set time: all-same-digit (`1111`) and
sequential ascending or descending (`1234`, `4321`).

**Storage.** HMAC-SHA256 the PIN under a `TRANSACTION_PIN_PEPPER` secret from
environment config, then bcrypt the result. A database dump without the
application's environment yields nothing.

**Enforcement.** Required on every money-moving request — no amount
threshold, no time-boxed unlock window.

**Lockout.** Dedicated `failed_pin_attempts` / `pin_locked_until` columns, 3
attempts / 15 minutes. A PIN lock blocks money movement only; login, profile,
and PIN reset stay reachable throughout. Lockout fires the existing
`security_alert` notification. Successfully setting a new PIN through the
reset flow clears both columns.

**Lifecycle.** Set, change, and reset all live in Phase 3, gated by the
step-up MFA challenge pattern established in ADR-0006. Enforcing a PIN with
no way to set one is not shippable, and a PIN with no recovery path is a
permanently unusable wallet.

## Alternatives considered

- **6 digits, no pepper.** 1,000,000 candidates raises a targeted offline
  crack from ten minutes to roughly sixteen hours, with no new secret to
  operate. Rejected on UX grounds — but it is the honest alternative, and
  the pepper's cost below is real. If the operational constraint ever bites,
  this is the fallback.
- **4 digits, bcrypt alone.** Rejected: this is the option where a database
  leak hands over every PIN in the system.
- **Threshold-based enforcement** (PIN only above some amount). Rejected —
  sub-threshold draining is the obvious bypass, and it only works alongside
  cumulative velocity limits, which are Phase 6 tier work. Building it now
  means building it wrong until then.
- **Time-boxed PIN unlock** (enter once, N minutes PIN-free). Rejected: a new
  piece of authenticated session state, with its own expiry and revocation
  semantics, to save four keystrokes — and it widens the window in which a
  stolen token inherits an already-unlocked session.
- **Reusing the login lockout columns.** Rejected for the self-disabling-
  remedy reason above.
- **Hard block until reset after 3 failures** (rather than a timed lock).
  Rejected: every mistyped PIN would route a user into the recovery flow, and
  recovery flows are where social-engineering fraud actually lives. That path
  should be rare.

## Consequences

- **The pepper can never be rotated.** There is no way to re-derive a hash
  under a new secret, so rotating `TRANSACTION_PIN_PEPPER` invalidates every
  PIN in the system and forces every user to set a new one. Treat it as a
  permanent key: back it up with the same seriousness as the database, and
  understand that losing it is equivalent to wiping every PIN. This is the
  price paid for keeping 4 digits.
- The pepper is a distinct secret from `ENCRYPTION_KEY`; the two are never
  interchangeable, since key separation by purpose is what limits the blast
  radius of either one leaking.
- Two lockout mechanisms now exist on one table with deliberately different
  thresholds. A reader encountering both should not "harmonize" them — the
  divergence is the point.
- Every future money-moving endpoint (withdrawal in Phase 4, bill-split
  settlement in Phase 8, scheduled payments in Phase 9) inherits the
  every-request enforcement rule rather than deciding it again.
