# ADR-0018: Smile ID, not Kora, backs `KycProvider` — Kora's Identity API doesn't do liveness

**Status:** superseded by [ADR-0020](0020-prembly-as-kyc-lookup-provider.md)
**Date:** 2026-09-20

## Context

docs/architecture.md §3 (line 40) names Kora's "built-in KYC/KYB
verification APIs" as part of why Kora was chosen as the payment provider
at all, and §6 Phase 6's original design assumed `KycProvider` would be
backed by Kora (`KoraSandboxKycProvider`), the same adapter-per-provider
pattern as `PaymentProviderAdapter`.

Checked against Kora's actual Identity API
(developers.korapay.com/docs/kyc-nigeria, /docs/nigeria-bvn,
/docs/nigeria-nin) during this phase's design pass:

- BVN and NIN lookup both return full government-record data in one call —
  name, DOB, phone, gender, **and address** (street, town, LGA, state) —
  so Tier 2's "address verification" needs no separate provider call at
  all; it's already returned by the BVN/NIN lookup Tier 1 already makes.
- BVN lookup optionally accepts a base64 selfie and returns a **face-match**
  result against the BVN-record photo. This is a static comparison against
  an enrollment photo, not liveness — no blink/motion/anti-spoof challenge,
  so a printed photo or a photo of a photo isn't necessarily caught. NIN
  lookup doesn't offer even this.

Kora's Identity API therefore cannot do what §6 Phase 6 actually asks for
("full KYC + liveness check" for Tier 3) — it does data lookup and,
optionally, a same-photo comparison, not liveness. This is the same shape
of finding ADR-0016 recorded for Phase 5's original chargeback-webhook
assumption: the original design's premise about what the provider's API
supports didn't survive contact with the provider's actual documentation.

Smile ID's Nigeria ID verification (BVN, NIN V2, NIN Slip, Virtual NIN,
Voter's ID) supports "Biometric KYC" — ID lookup and a selfie/liveness
check as one combined job, not two calls — with genuine active-liveness
detection (SmartSelfie: an anti-spoof model set, a "smile at the camera"
challenge, rejection of a resubmitted identical image). It also returns
address fields on the same ID types. It therefore covers the entire Phase 6
surface — BVN, NIN, address, liveness — in one provider, where Kora only
covered two of the four.

## Decision

The liveness part of this decision was later amended: see "Amendment (2026-10-21)" at the end.

`KycProvider` is backed entirely by Smile ID: `SmileIdKycProvider` (real
integration, Smile ID's sandbox environment — `sandbox_result` mocking, not
real BVN/NIN/NIMC/NIBSS data, consistent with §6 Phase 6's existing
"sandbox only, ever" rule) and `FakeKycProvider` (deterministic, no
network, for unit tests), the same two-adapter shape every other provider
interface in this codebase already uses.

Kora's Identity API is dropped from Phase 6's scope entirely. Kora is
unaffected as the payment/payout provider (`PaymentProviderAdapter`,
`KoraAdapter`) — this decision is scoped to identity verification only.

`KycProvider`'s verify methods (`verifyBvn`, `verifyNin`) each accept an
optional selfie parameter. When present, the same call returns a
liveness/face-match result alongside the identity data — matching Smile
ID's actual combined-job shape, rather than the two-call design
(verify-then-separately-submit-a-selfie) an earlier draft of this phase
assumed based on Kora's shape.

## Alternatives considered

- **Use Kora for BVN/NIN, add a second `LivenessProvider` interface backed
  by Smile ID or Dojah for liveness only.** This was the first shape
  considered, following §9's precedent that a capability an existing
  interface doesn't model (card tokenization) gets its own interface
  rather than a bolted-on method. Rejected once it became clear Smile ID's
  BVN/NIN lookup makes Kora's identical capability redundant — running two
  KYC providers for overlapping data, when one covers the whole surface,
  is exactly the module/dependency proliferation CLAUDE.md's general
  conventions warn against, just at the provider-integration layer instead
  of the module layer.
- **Keep Kora's face-match as "good enough" for Tier 3, relabel "liveness"
  as "facial verification" in the docs/code to match reality.** Considered
  and initially proposed, but rejected on explicit direction: the product
  requirement is liveness (anti-spoof), not face-similarity, and
  downgrading the requirement to match the cheaper provider's capability
  gets the causality backwards.
- **Dojah instead of Smile ID** for the liveness/KYC provider. Both offer
  Nigeria-ready liveness with sandbox environments. Smile ID's documented
  `sandbox_result` parameter gives deterministic, explicit control over
  which outcome a sandbox call returns (favorable for driving every branch
  in integration tests the way `FakeAdapter`'s existing fakes already do);
  Dojah's sandbox testing shape wasn't as clearly documented in the
  research done for this decision. Revisit if Smile ID's real sandbox
  integration surfaces problems this comparison didn't catch — same spirit
  as ADR-0007/ADR-0011's ledger note that a provider's real shape sometimes
  only becomes clear once actually integrated against.

## Consequences

- §3 (line 40) and §6 Phase 6 of docs/architecture.md both need a
  correction note pointing at this ADR, the same way §6 Phase 5 points at
  ADR-0016 for its own provider-assumption correction — Kora's KYC/KYB
  claim stops being a reason "Kora already covers this" for identity
  verification.
- A new config namespace (`SMILE_ID_*`) is added in the same change that
  wires up `SmileIdKycProvider` — consistent with the existing
  `KORA_SECRET_KEY`/`BREVO_API_KEY` pattern of provider credentials added
  only when the provider is actually wired up, not ahead of it.
- `KycProvider`'s contract tests (`test/contract/`, nightly cadence per
  docs/architecture.md's four-layer testing strategy) run against Smile
  ID's real sandbox, not Kora's — a new external dependency in CI's
  contract-test job, alongside the existing Kora contract tests for
  payments.
- Tier 3 no longer needs a second interface or a second provider
  integration, and confirms the phase's earlier scoping correction: Tier 3
  doesn't need new object-storage infrastructure either, since Smile ID's
  Biometric KYC job takes the selfie inline in the same request/response
  as everything else in this phase — nothing is persisted beyond the
  verification result.

## Amendment (2026-10-21): liveness is a separate, possibly asynchronous job

Checked against Smile ID's v3 docs while building liveness: Biometric KYC is
asynchronous only (`POST /v3/biometric_kyc` returns 202 with a `job_id`; the
result arrives by webhook or `GET /v3/status/{jobId}`) and takes a selfie plus
6-8 liveness frames, user details and a consent record, not a single selfie
string. The "one combined call" shape above therefore doesn't hold.

`KycProvider` keeps identity lookup (`verifyBvn`/`verifyNin`) synchronous and
adds `submitLiveness`, `getLivenessResult` and `parseWebhookJobId`.
`submitLiveness` returns either a final outcome (a synchronous provider) or a
pending job id (an asynchronous one); the service handles both, so another
provider of either kind can replace Smile ID without touching the service. A
`kyc_liveness_jobs` row tracks each submission, settled by a recurring poll
job and by a webhook that is only a trigger to re-poll (its body is never
trusted). Images are sent inline in the submit request and never stored.
