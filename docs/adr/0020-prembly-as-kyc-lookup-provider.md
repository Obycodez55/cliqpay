# ADR-0020: Prembly is the BVN/NIN lookup provider; Smile ID is removed

**Status:** accepted (supersedes [ADR-0018](0018-smile-id-for-kyc-and-liveness.md))
**Date:** 2026-10-23

## Context

ADR-0018 chose Smile ID to back `KycProvider` for BVN, NIN, address and
liveness. We never got access to Smile ID: no account could be created and no
sandbox keys were issued. `SmileIdKycProvider` was therefore written against
request and response shapes taken from documentation and never run against the
real service, and its own comments list the unconfirmed parts (field names,
the signing scheme, the token headers, the webhook job id). It has no value
to keep.

A sandbox research spike against Prembly (65 calls, nothing debited) is
recorded in `docs/research/prembly-kyc.md`, with sanitized responses in
`test/fixtures/prembly/`. It verified the BVN and NIN lookup shapes and the
auth scheme. It also showed that the sandbox returns one canned success for
every well-formed request, so failure paths (not found, blocked BVN, empty
wallet, rate limiting) can only be built from the docs.

## Decision

- `PremblyKycProvider` implements `verifyBvn` and `verifyNin`: BVN basic
  (`POST /verification/bvn_validation`) and NIN basic
  (`POST /verification/vnin-basic`), `x-api-key` auth, string bodies. It is
  selected with `KYC_PROVIDER=prembly`, with `PREMBLY_SECRET_KEY` required
  when selected and the base URL a constant in the provider. `KYC_PROVIDER`
  is `prembly | fake`; `fake` stays blocked in production.
- A lookup is decided from the HTTP status, `status`, `response_code` and
  `verification.status`, never from the free-text `detail`. HTTP 200 with
  `status: true`, code `00` and `VERIFIED` is a success. Code `01` is
  `not_found` and `07` is `mismatch`, and a recognised code outranks the HTTP
  status. Everything else throws, so the service releases the attempt and the
  user is never given a verdict for our own infrastructure's failure: codes
  `02` and `03` (our prepaid Prembly wallet is empty), 401, 403, 408, 429,
  every 5xx, an unexpected 400 (our DTOs already enforce 11 digits) and any
  unrecognised code.
- Dates of birth arrive as `DD-Mon-YYYY` (BVN) and `DD-MM-YYYY` (NIN); both
  are normalised to ISO before the same-person check, and anything
  unparseable becomes `undefined` rather than a guess.
- The NIN response carries a roughly 200 KB base64 photo. The adapter reads
  only the fields it needs, so the photo and every other raw body are never
  logged, stored, returned or put in an error.
- Every sandbox response carries `is_sandbox: true`. The adapter refuses it
  and logs an error when `NODE_ENV=production`, because sandbox and live keys
  share one host and a sandbox key in production would verify anyone.
- A code `03` logs a distinct error. A scheduled check of the wallet balance
  (`GET /api/v1/wallet`) is a follow-up, not part of this change.
- Smile ID is deleted completely: the provider and its spec, the `SMILE_ID_*`
  configuration, the `smileid` option and every documentation reference.
  ADR-0018 is kept as the decision trail and marked superseded.

## Liveness gap

Prembly's REST liveness is a single still image with no pass/fail field, so
it is a weak control for a wallet, and its widget flow (session, webhook,
status fetch) is only partly verified and cannot be tested without a funded
production wallet. Liveness is therefore a separate issue.

Until it lands, `PremblyKycProvider.submitLiveness`, `getLivenessResult` and
`parseWebhookJobId` throw `KycLivenessUnavailableException` (code
`LIVENESS_UNAVAILABLE`, HTTP 503), so Tier 3 is unreachable. The identity
part of a request that carries a liveness capture is still verified first,
and the service releases the attempt when `submitLiveness` throws. The
provider-agnostic liveness machinery (`kyc_liveness_jobs`, the poll job, the
trigger-only webhook route, `livenessResult`) stays, and `FakeKycProvider`
keeps driving its tests. Nothing has launched, so this is acceptable.

## Alternatives considered

- **Keep Smile ID alongside Prembly.** Rejected: it has never run against the
  real service and nobody can obtain access to test it.
- **BVN advance instead of BVN basic.** Rejected: it adds a photo and fields
  we do not use.
- **Prembly REST liveness for Tier 3 now.** Rejected for the reasons above;
  the widget path is the likelier fit and needs its own evidence.

## Consequences

- Prembly is prepaid. An empty wallet fails every verification (code `03`), so
  the wallet needs monitoring.
- Prembly has no idempotency or client reference; deduplication stays ours.
- Failure-path behaviour rests on synthetic fixtures built from the docs
  until it is confirmed against the live service.
- A BVN-vs-NIN same-person check cannot be exercised with sandbox data (the
  two sandbox persons differ); it is covered with constructed pairs.
- `test/contract/` gains a nightly Prembly spec that checks response shapes.
