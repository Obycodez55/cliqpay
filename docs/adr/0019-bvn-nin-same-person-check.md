# ADR-0019: BVN and NIN must belong to the same person, checked between the two identifiers

**Status:** accepted
**Date:** 2026-10-22

## Context

Tier 2 needs a BVN and a NIN, and Tier 3 adds liveness. Nothing tied the two
identifiers together: a user could verify their own BVN and anyone's valid NIN
and reach Tier 2, and a liveness check passed against one identifier would then
be taken as covering the other. The account's profile name was considered as the
reference and declined.

## Decision

Whichever identifier is verified second is compared with the first, so the
order doesn't matter. The check runs in the persist transaction, under the
per-user advisory lock, after the provider has verified the identifier and
before anything is written. Each lookup's legal name and date of birth are
stored per source in `kyc_verifications.identity`.

Names match when every token of the shorter name appears in the longer one
(initials match a token starting with that letter) and at least two non-initial
tokens are shared; a one-token name matches if that token is present. Names are
compared after Unicode NFKD, stripping diacritics, lowercasing, and turning
punctuation into token breaks, so order, a missing or extra middle name and
hyphenation don't matter. Dates of birth must be equal when both sides have one;
if either lacks one, the names decide. If either side has no legal name, the
check fails closed.

A mismatch throws `IDENTITY_MISMATCH` (422), persists nothing, and leaves the
reserved attempt counted as failed.

## Alternatives considered

- **Compare against the account profile name.** Declined: profile names are
  self-typed and often differ legitimately in form from government records.
- **No check.** Leaves the Tier 2 and liveness gaps above open.
- **Delete the attempt on mismatch.** Rejected: a mismatch costs two provider
  lookups, so letting it be free would allow unlimited probing of identifier
  pairs.

## Consequences

- A second identifier that matches the first is the same person, so liveness
  passed on either one covers both.
- With no profile match, one mistyped or squatted identifier on an otherwise
  empty account is still possible; only the pair is cross-checked.
- Provider name formats differ (the NIN may order names differently from the
  BVN), so the token rule is deliberately tolerant; it will need tuning against
  real sandbox data.
