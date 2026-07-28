# ADR-0005: Split identity (`users`) from authentication mechanics (`auth`)

**Status:** accepted
**Date:** 2026-07-27

## Context

`auth` was originally scoped as authentication mechanics — login, sessions,
MFA, verification (docs/architecture.md §10) — but it also ended up owning
the `User` entity itself, since registration had to create *something* and
`auth` was the only module that existed at the time. That was tenable while
`auth` was the only consumer of a person's identity. Issue #8 (profile
view/update, wallet balance, username cooldown) was about to make it not
tenable: `GET/PATCH /profile` and username management are about a person,
not about how they authenticate, and bolting them onto `auth` would have
been the third or fourth unrelated responsibility stacked on one entity.

This is the classic "god `User`" problem: a single entity that means
something different to every part of the system — to `auth`, a bag of
credentials; to a profile screen, a person; to `ledger`, just an owner id —
always drifts into a dumping ground for whatever the current feature needs,
because there's no module boundary forcing a decision about what actually
belongs there.

The sharper, forward-looking reason to fix this now rather than later:
`username` is a payment-routing key (Phase 3: "send money by username or
email"). `payments` — a core module — will need to resolve a username to a
`userId`. If identity stayed inside `auth`, resolving a username would mean
either `payments` depending on `auth` (mixing "who is this person" with
"how do they log in," a dependency with no architectural justification) or
duplicating identity data into `payments`. Neither is acceptable, and the
problem only gets more expensive to fix the longer `User` stays where it is.

## Decision

Split into two **core** modules with a one-way dependency, `auth → users`,
never the reverse — the same shape Auth0/Okta/OIDC use: an identity
provider owns the person; auth mechanics are layered on top and verify
*against* that identity, not the other way around.

**`users`** owns identity and depends on nothing else in this app:
`User` (`id`, `email`, `phone`, `username`, `usernameChangedAt`,
`emailVerifiedAt`, `phoneVerifiedAt`, `firstName`, `lastName`) and
`UsersService` — `createUser`, `findByEmail`, `findById`,
`markEmailVerified`, `markPhoneVerified`, `getProfile`, `updateNames`,
`changeUsername`, `updateProfile`. Owns `GET`/`PATCH /profile`.

**`auth`** owns IAM mechanics and depends on `users` + `ledger`, as it
already did on `ledger`: a new `Credential` entity (`userId`, `passwordHash`,
`transactionPinHash`, `failedLoginAttempts`, `lockedUntil`) holds everything
that used to be bolted onto `User` for login/lockout purposes, 1:1 with a
`users` row via a plain `userId` column — no FK, cross-module reference per
ADR-0002. `Session`, `MfaMethod`, `MfaChallenge`, `TrustedDevice`,
`VerificationCode` stay in `auth`; their existing FKs to `users(id)` are
dropped (`DropUserForeignKeys` migration) since that reference is now
cross-module, same treatment `Account.userId`/`PushToken.userId` already
get.

`register()` orchestrates `usersService.createUser(manager, ...)` → insert
`Credential` → `mfaService.enrollEmailMethod(manager, userId)` →
`ledgerService.createUserWallet(manager, userId, ...)`, all inside the
existing `runInTransaction` — passing the caller's `EntityManager` into
another core module's service is already how the wallet gets created
atomically alongside the user; `users` being a separate module doesn't
change that pattern, it just adds one more participant to it.

### Which operations cross the boundary, and why that's the right amount

This is the check used while rewiring `auth`, and it's kept here as the
argument for why `Credential` earns its keep rather than being denormalized
away:

- **Alone, never touch `users`:** `refresh`, `logout`,
  `password-reset/complete`, `change-password` (issue #11, not built yet),
  `mfa/totp/enroll`+`confirm`, `mfa/verify`, all lockout bookkeeping. This is
  most of `auth`'s surface area, and none of it needs to know anything about
  who the person is — only which `Session`/`Credential`/`MfaMethod` row it's
  operating on.
- **One resolve at the door, then alone:** `login` (`email → userId` via
  `usersService.findByEmail`), `password-reset/request` (same, plus the
  address to send to). A single lookup, not a dependency threaded through
  the whole flow.
- **Genuinely crosses:** `register` (mints an identity — has to),
  `verifyEmail`/`verifyPhone` (writes an identity attribute — has to), any
  verification-code send that needs a contact address (reads an identity
  attribute — has to).

If an operation had turned up touching `users` outside that last category,
that would have been a sign the split was wrong, not something to route
around. It didn't.

### `mfaMethods` dropped from `GET /profile`

The pre-split `ProfileResponseDto` included `mfaMethods: MfaMethodType[]`,
sourced from `MfaService.getEnrolledMethodTypes` (an `auth`-internal
service). `users` cannot depend on `auth` — that's the one-way rule this
whole ADR exists to establish — so `ProfileController` (in `users`) cannot
call into `MfaService`, and `UsersService.getProfile` cannot either.

Decided to drop `mfaMethods` from the response rather than force the
dependency. The alternatives were worse: exposing it via a new endpoint the
frontend has to call separately just relocates the coupling to the API
surface instead of removing it, and denormalizing enrolled-method-types onto
`User` (kept in sync via a domain event from `auth`) is real scaffolding for
a single read-only field with no consumer asking for it yet — exactly the
kind of ahead-of-need build CLAUDE.md's incremental-build rule rules out.
This is a real, visible regression for any client currently reading
`mfaMethods` off `/profile` — noted here rather than silently. If a caller
needs it, the shape to build is `auth` exposing a small
`AuthService.getEnrolledMethodTypes(userId)` (already effectively exists as
`MfaService.getEnrolledMethodTypes`, just needs re-exporting) and the
frontend composing two calls, or a dedicated MFA-status endpoint under
`auth` — not a dependency from `users` back into `auth`.

### Denormalizing `email` onto `Credential` — considered and rejected

`login()` needs one `email → userId` lookup before it can touch
`Credential` at all. The alternative — storing `email` directly on
`Credential` to avoid that lookup — was explicitly considered and rejected:
it creates a second source of truth for a field that change-email (issue
#9) will have to keep in sync under step-up MFA, for a savings of exactly
one indexed query at the top of exactly one flow. The lookup cost is real
but trivial; the synchronization liability is not.

## Alternatives considered

- **Leave `User` in `auth`, add profile/wallet endpoints there too** —
  rejected; this is the status quo this ADR exists to fix. It would have
  worked for issue #8 in isolation but makes the eventual `payments`
  username-resolution problem strictly worse to unwind later.
- **`users` depends on `auth` instead of the reverse** — rejected; this is
  backwards from how every real IdP-based system is shaped, and it would
  mean `payments` (needing only identity) transitively depends on all of
  `auth`'s login/session/MFA machinery to resolve a username.
- **No split — keep credentials on `User`, just add `users`-flavored
  read methods to `AuthService`** — rejected; doesn't fix the actual
  problem (one entity serving unrelated concerns), just adds another
  interface on top of it.

## Consequences

- `auth` now depends on `users` — a new cross-module dependency, but a
  one-way one with no cycle, which is the property that matters (see
  ADR-0002's cross-module-reference rules, amended alongside this ADR).
- Four FK constraints (`sessions`, `verification_codes`, `mfa_methods`,
  `trusted_devices` → `users.id`) are dropped and become
  application-enforced only, same standing trade-off ADR-0002 already
  accepts for `Account.userId`/`PushToken.userId`.
- `GET /profile` no longer returns `mfaMethods` — see above. Any consumer
  relying on that field needs a follow-up before this ships to them.
- Any future core module needing identity (`payments` resolving a username,
  eventually) depends on `users` directly, not on `auth` — this is the
  whole point of the split.
