# ADR-0003: Session and TrustedDevice each get their own `device` (jsonb), same shape

**Status:** accepted
**Date:** 2026-07-21

## Context

Issue #3 (login/sessions/lockout) shipped `Session` without any request-metadata capture — no IP address, no user-agent — only the nullable `trustedDeviceId` placeholder this issue (#4) was meant to wire up. That issue's own review comment flagged the gap explicitly and deferred the decision here rather than bolting it on separately, reasoning that `TrustedDevice` was about to need its own device-context capture anyway, and deciding both at once avoids ending up with two different shapes for essentially the same thing.

The open question, verbatim from that comment: does `Session` get its own request-metadata columns (independent of trust), or does it only gain device context via the `trustedDeviceId` relation?

## Decision

Both `Session` and `TrustedDevice` get their own `device` column (`jsonb`, not null) — same shape, captured independently, at different moments:

- **`Session.device`**: captured at session-creation time, on every login that produces one — both the trusted-device-skip path and the post-MFA-verify path (`AuthService.createSession`). This is per-login context: which IP and client actually authenticated this time.
- **`TrustedDevice.device`**: captured once, at issuance (`MfaService.issueTrustedDevice`, called only from `AuthService.verifyMfaChallenge`). This is the device's own record: where and on what client trust was first established, independent of any one session — a trusted device outlives any single login and accumulates many sessions over its ~30-day window.

`device` is a single `jsonb` column, not flat `ipAddress`/`userAgent` columns, typed on the TypeScript side as a concrete `DeviceMetadata` interface (`auth/internal/device-metadata.util.ts`) rather than `Record<string, unknown>` — Postgres won't enforce the shape, but the application always writes and reads it through that one type:

```ts
interface DeviceMetadata {
  ipAddress: string;
  userAgent: string | null;
}
```

`userAgent` is nullable because not every client sends the header (a bare `curl` request, some non-browser clients); `ipAddress` is always present since Express provides one for any real socket connection. Both values come from the request the controller is already handling — `AuthController.login` and `MfaController.verify` extract them via a shared `extractDeviceMetadata(req): DeviceMetadata` and pass the struct straight through to `AuthService`/`MfaService`, which store it verbatim as the `device` column's value; no field-by-field mapping anywhere in that path.

No `X-Forwarded-For` handling — nothing in this app configures a trust proxy yet (`app.set('trust proxy', ...)` isn't called anywhere), so trusting that header today would mean trusting a value any client could set. Revisit once the app actually sits behind a configured reverse proxy.

## Alternatives considered

- **Flat `ipAddress`/`userAgent` columns instead of `jsonb`** — the original version of this decision, superseded during review. Rejected in favor of `jsonb`: this is device-shaped data more likely to grow a field (platform, device name, a future WebAuthn-style attestation) than to need SQL-level filtering (`WHERE ip_address = ...`) or an index on either value — nothing in this codebase queries by IP or user-agent today. One column reads as "the device context for this row" rather than two loosely-related flat ones, and a future field is an application-level type change, not a migration.
- **Session only gains device context via `trustedDeviceId`** — rejected. Most logins are on already-trusted devices and never create a fresh `TrustedDevice` row, so this would mean the majority of sessions carry no device context at all. It also conflates two different lifetimes: a session is per-login, a trusted device spans many logins — collapsing them loses the "which specific login came from where" signal a security/session-management view would want.
- **One shared `device_metadata` table both `Session` and `TrustedDevice` reference** — rejected as premature normalization. There's no current requirement to query device context independent of its owning row, and a shared table would need its own lifecycle/ownership rules (deleted when the last referencing row is? kept forever?) for no present benefit — the same reasoning that rules out a shared table applies even more directly against a shared table once the value itself is already a self-contained `jsonb` blob.
- **`TrustedDevice` only, `Session` gets nothing new** — rejected for the same reason as the `trustedDeviceId`-only option, just from the other direction: it would mean untrusted-device logins (the ones actually worth auditing — see the challenge/verify flow) have no metadata until they earn trust.

## Consequences

- Two writes instead of one wherever both a `Session` and a `TrustedDevice` are created together (`verifyMfaChallenge`) — an acceptable, small duplication given they answer different questions ("what happened at this login" vs. "what does Cliqpay know about this device").
- `Session.device` is set once at creation and never updated by `refresh()` — a token rotation isn't a new device showing up, it's the same session continuing, so there's nothing new to capture there. If that assumption changes (e.g. wanting to detect a refresh token being used from a surprising new IP), that's a future, separate decision, not implied by this one.
- No device-context capture exists yet for `refresh()` or `logout()` — those don't create rows, only mutate existing ones, so this ADR doesn't cover them.
- Reading `device.ipAddress`/`device.userAgent` in application code (tests, any future admin/session-management view) always goes through the `DeviceMetadata` type — TypeORM round-trips `jsonb` as a parsed object automatically, so this costs nothing beyond importing the type.
