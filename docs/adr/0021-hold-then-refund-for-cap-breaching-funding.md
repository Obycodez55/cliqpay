# ADR-0021: A funding that would breach the balance cap is held in suspense and refunded through the provider

**Status:** accepted
**Date:** 2026-10-23

## Context

Phase 6 enforces the tier balance cap at funding initiation (#44) and on incoming P2P transfers, and ADR-0017 left "funding that completes by webhook after initiation" outside the cap. Issue #48 lists what that leaves open: a funding completing after the user's balance changed, and a checkout paid more than 24 hours after initiation (#47 stops a pending funding older than 24 hours from reserving headroom, so a late payment can overshoot). `postFunding` also takes no per-user lock, so a funding credit and a P2P transfer to the same user can overshoot together.

Money that has already arrived cannot be rejected the way an initiation can. Options recorded in #48: credit it and flag the account, hold the excess in a suspense account, or refund through the provider. The decisions of 2026-10-23 chose to hold and then refund. Kora's Refunds API was checked against its sandbox before this design was finalised ([docs/research/kora-refunds.md](../research/kora-refunds.md), 72 calls, fixtures in `test/fixtures/kora-refunds/`); the full design is [docs/research/kora-refunds-design.md](../research/kora-refunds-design.md). Facts from that spike that shape the decision:

- A refund with no `amount` returns the payer's gross payment, including the provider fee, and Kora does not return its pay-in fee (verified for bank-transfer charges in the sandbox only).
- The refund webhook carries our refund reference but not our payment reference; the signature is the same HMAC over `data` the app already verifies, on the same endpoint.
- A refund reference can never be reused, even after a failure; there is a per-payment cool-down of about a minute; the refund debits Kora's balance at initiate time.
- There is no refund-related behaviour the sandbox cannot show except real `processing` delays and real failures.

## Decision

1. **Hold, then refund.** When a funding that completes by webhook or poll would take the wallet over its tier cap, it is not credited. It is posted into a new provider-scoped system liability account `suspense`, the funding row becomes `held`, and a refund of the credited amount (`amount` = net, the provider fee is not refunded: provisional, see below) is initiated through the provider after the transaction commits.
2. **The check runs under the user lock, in the posting transaction.** `payments` takes the funding completion path for both webhook and poll, calls a new non-throwing `kyc.checkIncomingCredit(manager, userId, amount, readBalance)` (which takes `pg_advisory_xact_lock(hashtext(userId))` first, the lock the other kyc checks use), then calls `ledger`'s within-transaction posting variant: credit the wallet, or hold. `ledger` imports nothing; `kyc` imports no ledger code (the ADR-0017 reader pattern); `payments` names no account (ADR-0008). The check compares the stored balance plus the credit with the cap, deliberately not counting other pending fundings, which are checked when they complete.
3. **Postings.** Hold: `DR float, CR suspense` for the net amount plus the usual fee expense/recovery pair. Refund settled: `DR suspense, CR float` for the net amount. Refund failed: no posting. §4.3 becomes `float = Σ wallets + fee_income + suspense`.
4. **State machine.** `funding` gains the statuses `held` and `refunded`. A new type `funding_refund` carries one row per refund attempt (`pending` -> `completed` | `failed`), referencing the funding row, with the refund reference as both `reference` and `provider_reference`, derived from the funding row's id and the attempt number (`rfd-<uuid>-<n>`, 44 characters at most).
5. **A failed refund stays in suspense** and is recovered automatically: a refund poll (same repeatable-job pattern as the funding and withdrawal polls) resolves stale pending attempts through `verifyRefund`, retries are bounded (five attempts, spaced 0, 10 minutes, 1, 6, 24 hours, each with a new reference), and an ops email alert fires when retries are exhausted or money has been held for 24 hours. The external reconciliation compares float minus in-flight refunds with the provider balance and reports the suspense balance.
6. **Fee treatment (provisional).** The refund is for the credited principal, so Cliqpay bears no provider fee and the payer loses it, which the notification states. This rests on sandbox bank-transfer evidence only and is to be revisited after hosted-checkout and card refunds are verified and Kora answers its fee questions. Refunding the gross instead is contained to one adapter argument and one posting variant (plus an invariant amendment).
7. **Exempt credits stay exempt.** Withdrawal reversals and chargeback postings do not take the user lock or the cap check; they can overshoot by their own amount if they race a funding.

## Alternatives considered

- **Credit then reverse (credit the funding, flag the account, claw back).** Rejected by the 2026-10-23 decision: the wallet would briefly exceed the cap, the user could spend the excess before the reversal, and the reversal would need a negative-balance path (the chargeback pattern) for money Cliqpay itself chose to credit.
- **Hold with no refund until the user upgrades.** Possible, but leaves payer money parked with no end date; the decision was to refund. A grace window that credits instead if the user verifies in time can be added later (design question 8).
- **Partial credit up to the cap, refund the excess.** Rejected by decision (full refund of the breaching payment); it also would put a refund below Kora's minimum in play more often.
- **Refund the gross (omit `amount`).** Makes the payer whole but costs Cliqpay the provider fee on every refund (NGN 53.75 on NGN 1,000 in the sandbox), breaks the §4.3 cancellation of fee expense and recovery, and gives a user a slow way to drain money through repeated late payments. Kept as the fallback if the fee decision is reversed.
- **Track refund state as funding statuses (`refund_pending`, `refund_failed`) instead of attempt rows.** Rejected: duplicates facts held by the attempt rows and cannot represent several attempts; a new reference is mandatory per attempt in Kora anyway.
- **A `refunds` table owned by `payments`.** Rejected: `payments` owns no tables (ADR-0008) and the attempt rows are accounting-relevant, so they live in `transactions` like withdrawals and chargebacks.
- **Run the check inside `ledger` with a callback.** Rejected for the reason ADR-0017 gives for the daily limit: a hook in `ledger` for one caller's concern.
- **Count other pending fundings in the completion check.** Rejected: it would hold payments that fit, creating refunds that cost the payer a fee for no reason.

## Consequences

- A user whose late payment is held is refunded the credited amount; the provider fee is lost to them, and the email says so. Volume is expected to be very low: it needs a checkout paid after 24 hours or an exempt credit landing in between.
- `ledger` gains the `suspense` account (CHECK migration, seed), the statuses `held` and `refunded` and the type `funding_refund` (CHECK migration), within-transaction posting variants and the read methods the poll and reconciliation need; `kyc` gains one method; `payments` gains `completeFunding`, refund webhook handling, a refund poll processor and two adapter methods (Kora and Fake); `notifications` gains three catalog entries.
- Every place that asserts the §4.3 invariant gains the suspense term; the property-based test gains hold, settle, fail and retry operations.
- The external reconciliation must subtract refunds already initiated at Kora but not yet settled in the ledger, or it raises false alarms in the processing window.
- The wallet history is entry-based, so held and refunded payments do not appear in it until a follow-up adds them.
- Open items that need a human before the fee treatment is final: a manual hosted-checkout card and transfer refund test, and answers from Kora support (kora-refunds.md sections 9 and 10).
- Updating the docs: architecture.md §3.5, §4.1, §4.2, §4.3, §4.4, §5, Phase 2 and Phase 6 (replace "out of scope" with this decision); ADR-0017 (pointer, plus a note recording that a raced-twin transfer replay returns the twin's committed result without re-running the recipient check, which is correct).
