# ADR-0006: Change-email step-up MFA — 3-call challenge/verify/confirm, no proof token

**Status:** accepted
**Date:** 2026-07-28

## Context

Issue #9 requires change-email to be gated by a **step-up**
MFA challenge — re-proving MFA on an already-authenticated session,
unconditionally, regardless of trusted-device status (docs/architecture.md
§3.8). Issue #4 only built MFA for login, where the challenge is created
implicitly as a side effect of `login()` failing to find a trusted device.
There's no equivalent implicit trigger here — the caller already has a
session and is asking to change a security-relevant field directly — so
issue #9 explicitly leaves the request/response shape of step-up as an open
design decision.

MFA is inherently two-phase: a code has to be dispatched (email/SMS/TOTP)
and read by the user before it can be submitted back. That means
`change-email` cannot single-handedly both trigger and consume a step-up
challenge in one HTTP call — something has to kick the challenge off first.

Separately, `change-email` sends a verification code to the *new* address
before the email actually changes (per the issue, reusing
`VerificationCodeService` with `purpose: 'email_verification'`, same as
issue #5). `VerificationCode.consume()` only ever returns `{ userId }` —
nothing today remembers which address a given code was issued for, which
matters here because the address isn't the user's current one yet.

## Decision

**Three endpoints, all reusing existing machinery instead of introducing new
token concepts:**

1. `POST /auth/change-email/step-up` — creates a step-up `MfaChallenge`
   for the caller (`MfaService.createStepUpChallenge`, sharing
   `createChallengeForLogin`'s method-picking/dispatch logic) and returns
   `{ challengeId, method, expiresAt }` — the same shape `login()`'s
   `mfaRequired: true` branch already returns.
2. `POST /auth/change-email` — body `{ newEmail, challengeId, code }`.
   Verifies the step-up challenge via the existing
   `MfaService.verifyChallenge` (same 5-attempt lockout, TTL, single-verify
   as login), checks the challenge's owner matches the caller, stashes
   `newEmail` on `User.pendingEmail` (new nullable column — `email` itself
   stays untouched until confirm), sends the verification code to the new
   address, and fires a fire-and-forget `SECURITY_ALERT_EVENT` to the
   *current* address.
3. `POST /auth/change-email/confirm` — body `{ code,
   revokeOtherSessions }`. Consumes the verification code, checks its owner
   matches the caller, and only then swaps `pendingEmail` into `email`.

All three routes are added to the existing `AuthController` (`@Controller
('auth')`), not a new controller or route prefix. The mechanics involved —
`MfaChallenge`, `VerificationCode`, `Session` — are entirely `auth`'s own
tables; nothing about this flow touches `users` except the single
`UsersService.setPendingEmail`/`confirmPendingEmail` calls at the point
identity actually changes, the same shape every other `auth`→`users`
crossing already takes (ADR-0005). There's no reason to invent a second
controller or borrow `/profile`'s route prefix just because the *result* is
an identity field — `verify-email`/`verify-phone`/`password-reset` all
already live under `/auth` despite also ultimately writing to `users`.

Both `verifyChallenge` and `consume` return a bare `userId` with no caller
scoping — they were built for pre-auth flows (login, password reset) where
there's no `req.user` to check against. Since this flow *is* authenticated,
`AuthService` checks the returned `userId` against the caller's own and, on
mismatch, throws the same exception the method already throws for its
ordinary failure case (`MfaChallengeInvalidException`,
`VerificationCodeInvalidException`) — no new exception type, no signal about
whose challenge or code it actually was.

## Alternatives considered

- **A single opaque "step-up proof" token** — `POST /mfa/step-up` +
  `POST /mfa/step-up/verify` return a short-lived proof token that
  `change-email` takes instead of `challengeId`+`code`. Rejected: this adds
  a second token concept with its own replay/expiry/single-use rules
  layered on top of `MfaChallenge`, which already has all of that. The only
  thing it buys is not re-passing `challengeId`+`code` to `change-email`,
  which isn't worth a parallel security primitive.
- **`change-email` triggers the step-up challenge itself on a first call
  with no code, then expects the code on a follow-up call to the same
  endpoint** — rejected: overloads one route with two different meanings
  based on which fields are present, which is more surprising for a client
  to implement correctly than a dedicated `step-up` endpoint.
- **Routing under `/profile` (matching issue #8's `GET`/`PATCH /profile`)
  via a second, `auth`-internal controller** — tried first, then reverted.
  The reasoning was that email is identity data so its URL should read like
  the rest of the profile surface even though `auth` owns the mechanics.
  Rejected on review: every other identity-adjacent write `auth` already
  does (`verify-email`, `password-reset`) lives under `/auth`, not
  `/profile`, precisely because the *mechanics* — not the field being
  written — are what the module boundary is about. A second controller
  existed only to preserve that borrowed prefix; once the prefix goes, so
  does the reason for a second controller, and the three endpoints fold
  into the existing `AuthController` alongside `verify-email`/
  `password-reset`, which they resemble far more than they resemble
  `GET`/`PATCH /profile`.
- **A generic `metadata: jsonb` column on `VerificationCode`** instead of
  `User.pendingEmail`, to hold the target address (and be reusable for
  future purposes). Rejected per CLAUDE.md's incremental-build rule — issue
  #9 only needs one field, and `pendingEmail` keeps the write inside
  `UsersService` as an ordinary identity-attribute write, the same shape
  `markEmailVerified` already is, rather than introducing a generic
  free-form column with no current second consumer.

## Consequences

- `MfaService.createStepUpChallenge` is generic over any user, not
  change-email-specific — issue #10 (change-phone) and #11
  (change-password) can call it directly for their own step-up needs
  without new MFA plumbing.
- Clients implementing change-email make three calls, not two — an
  unavoidable consequence of MFA being challenge/verify by nature, not a
  cost specific to this design.
- `User.pendingEmail` is a second piece of state to reason about
  alongside `email`/`emailVerifiedAt`; it's cleared on confirm, and there's
  no expiry on the pending value itself — it just sits there, harmlessly
  unused, until either confirmed or overwritten by a later change-email
  attempt (the verification code it's tied to does expire, per the usual
  TTL, at which point the pending value becomes unreachable dead state
  until overwritten — acceptable for now, not worth a cleanup job at this
  scale).
