# Design: hold a cap-breaching funding in suspense, then refund it through Kora (issue #48)

Status: proposal for sign-off. No production code has been written. Evidence: [kora-refunds.md](kora-refunds.md) and `test/fixtures/kora-refunds/`. The decision record is the draft [ADR-0021](../adr/0021-hold-then-refund-for-cap-breaching-funding.md).

Decisions already made (issue #48 comment, 2026-10-23), not reopened here:

1. Hold then refund, not credit then reverse. A funding completed by webhook or poll that would take the wallet over its tier cap is not credited; it is posted into a system suspense account and refunded to the payer through Kora after the database transaction commits. The cap check is made under the per-user advisory lock.
2. Full refund of the breaching payment, no partial credit and refund of the excess.
3. The provider-fee treatment on a refunded payment was unknown; this document records what Kora actually does and states the posting provisionally.
4. A failed refund stays in suspense with an ops alert, with automatic reconciliation: a poll for dropped refund webhooks, bounded retry, an alert when held money is unresolved for too long, and the invariant and external reconciliation accounting for the suspense balance.

## 1. What the spike changed in the design

| Finding (section of kora-refunds.md) | Design consequence |
|---|---|
| Kora keeps its pay-in fee; the default refund returns the payer's gross (3) | Refund the credited principal explicitly (`amount` = net). Cost-neutral for Cliqpay; the payer bears the fee. Provisional (section 3.4). |
| The refund webhook's `payment_reference` is a Kora-internal id (1.2, 4) | Correlate only on the refund `reference`, derived deterministically from a ledger-owned id (section 7). |
| A refund reference is burnt forever, even after a failure; a new attempt needs a new reference; about 60 s cool-down per payment (5) | One ledger row per attempt, reference carries the attempt number; retry gap at least 10 minutes. |
| The refund is debited from Kora's balance at initiate time and is `success` within a second in the sandbox (3, 8) | The hourly reconciliation must subtract refunds in flight, or it raises false alarms (section 9.4). |
| The webhook shape and signature equal what `handleKoraWebhook` already verifies (4) | No new endpoint or verification code; add a dispatch branch. |
| The sandbox cannot show `processing` for a while or a real failure; the NGN 100 minimum is not enforced (5, 6) | Fake adapter models failure and pending; design treats the minimum as live-enforced (section 12.1). |
| A pending (unpaid) charge cannot be refunded: 404 "Transaction not found" (5) | A refund is only ever initiated after `charge.success` was processed, which is the case by construction. |

## 2. Accounting model

### 2.1 The suspense account

| Role | Provider-scoped? | Type | Purpose |
|---|---|---|---|
| `suspense` | Yes (`provider = 'kora'`), per currency | Liability | Money that physically sits in the provider's float but is owed back to a payer, not to a user wallet. |

Why provider-scoped, like `float`: the held money is part of one provider's balance, and the §4.3 invariant is already per provider and currency for float. Why a liability: Cliqpay owes it to the payer.

Name: `suspense` (not `refund_suspense`), because the same account is the natural home for any other "received but not creditable" case that comes later; no such case is designed here.

How it is seeded: add `{ type: 'liability', role: 'suspense', provider: 'kora' }` to `SYSTEM_ACCOUNTS` in `src/database/seed-system-accounts.ts`, and call `seedSystemAccounts(queryRunner, 'NGN')` from the new migration (the function is idempotent via `ON CONFLICT`, as its comment describes), so an existing database gets the row and a fresh one gets it from migrations.

Schema: `AccountRole` gains `'suspense'`; migration drops and re-adds `CHK_accounts_role` with `('float', 'fee_income', 'fee_expense', 'fee_recovery', 'suspense', 'user_wallet')` (the constraint is defined in `1784628665852-CreateUsersAndAccounts.ts`). `UQ_accounts_system` (role, provider, currency where user_id is null) already covers the new role. `CHK_accounts_type` needs no change.

### 2.2 The invariant (§4.3)

```
Σ over providers p: float_<ccy>[p] = Σ(user wallet balances) + fee_income_<ccy> + Σ over providers p: suspense_<ccy>[p]
```

`fee_expense` and `fee_recovery` still cancel and stay out, provided the fee treatment of section 3 is kept (see 3.4 for what changes if it is not). Consequences:

- The internal invariant exists today only as a test helper (`assertInvariantHolds` in `test/integration/ledger-funding-invariant.integration-spec.ts`; there is no production check). Every copy of that assertion gains the suspense term; the property-based test gains the new operations (section 13).
- The external reconciliation compares `float` against Kora's balance. Held money is still in Kora's balance, so float does not change when a payment is held; it drops when the refund settles. No change to the comparison itself is needed except the in-flight correction in 9.4. The reconciliation report and the mismatch alert gain the suspense balance, so an operator can see how much of the float is owed back.

## 3. Postings

All amounts are minor units through `Money`. Example: net NGN 1,000.00, provider fee NGN 13.97 (customer paid 1,013.97, the ADR-0007 sample).

### 3.1 (i) Funding held instead of credited

On the existing funding row (`type = 'funding'`), status `pending` to `held`, in the same transaction that took the user lock and found the credit would breach the cap:

```
DEBIT  float_ngn[kora]        net_amount
CREDIT suspense_ngn[kora]     net_amount
DEBIT  fee_expense_ngn        provider_fee
CREDIT fee_recovery_ngn       provider_fee

metadata: { grossAmount, heldAt }
```

The fee pair is posted exactly as for a normal funding: the payer paid it and Kora took it, so it is recovered from the payer. This is identical to §4.2's Funding except the wallet credit becomes a suspense credit. Debits equal credits (net + fee each side). No wallet row is touched or locked.

In the same transaction a refund-attempt row is created (type `funding_refund`, status `pending`, no ledger entries, section 5), so the attempt exists durably before Kora is called.

### 3.2 (ii) Refund settled

On the `funding_refund` row, `pending` to `completed`, and the funding row `held` to `refunded`:

```
DEBIT  suspense_ngn[kora]     net_amount
CREDIT float_ngn[kora]        net_amount
```

Kora was asked to refund exactly `net_amount` (section 3.4), so Kora's balance fell by `net_amount` and float falls by the same. The payer receives `net_amount` and keeps bearing the provider fee, as with any funding. Net effect over the whole life of the payment: float, suspense, wallets and fee income all return to where they started; only the fee pair has moved, by equal amounts, as for any funding. The success handler cross-checks the provider-reported refund `amount` against the row's amount, as `completeWithdrawal` does, and leaves the row pending with an error log on a mismatch.

### 3.3 (iii) Refund fails, and later retries

- Failure (`refund.failed`, a poll result `failed`, or a synchronous rejection): the `funding_refund` row goes `pending` to `failed`. **No ledger entries.** The money stays in suspense; the funding row stays `held`.
- A retry is a new `funding_refund` row (new reference, section 7) created later under the retry policy (section 9.2). A success on any attempt posts (ii) once. Only one attempt row can be `completed` per funding: the `held` to `refunded` flip is a status-guarded UPDATE, so a second success for the same funding (for example a late webhook for an attempt believed failed) finds the funding already `refunded` and is logged as an anomaly needing attention, not posted (the mirror of `completeWithdrawal` on a reversed transaction).

### 3.4 The fee treatment, stated provisionally

Evidence (kora-refunds.md section 3): Kora returns no fee, and an `amount`-less refund returns the payer's gross, which would cost Cliqpay the fee (NGN 53.75 per NGN 1,000 for a bank-transfer charge). Two options:

| | N: refund the principal (recommended, provisional) | G: refund the gross (omit `amount`) |
|---|---|---|
| Call | `amount = net_amount` | no `amount` |
| Kora balance change | -net | -(net + fee) |
| Payer | gets back net, loses the provider fee | made whole |
| Cliqpay cost | none | the provider fee on every refunded payment |
| Settlement posting | DR suspense net / CR float net | DR suspense net, DR fee_recovery fee / CR float net + fee (reverses the recovery; the fee becomes a real expense) |
| §4.3 | unchanged apart from suspense | breaks as written: float = Σ wallets + fee_income + suspense - (fee_expense - fee_recovery) |
| "Full refund" in the decision | full refund of the credited amount | full refund of what the payer paid |

N is recommended because it needs no new loss accounting, leaves the invariant as above, and removes the abuse cost described in section 11. It is provisional: it rests on bank-transfer charges in the sandbox only; the user asked for the fee treatment to be revisited once known. Switching to G later is contained: one adapter argument (`amount` omitted) and one posting variant in `ledger`, plus the invariant amendment; no schema change. The refund email must say plainly that the provider fee is not refunded under N.

## 4. Where the cap check lives (module boundaries)

Constraints: `ledger` imports no other module; `kyc` imports no ledger code; `payments` owns no tables and never names a system account; cross-module side effects are domain events published after commit.

```
payments.completeFunding(facts)            // the one funnel for webhook and poll
  ctx = ledger.findFundingOwner(reference)               // read: userId, status (userId never changes)
  if no ctx or status != pending -> return null          // duplicate
  runInTransaction(dataSource, manager =>
    verdict = kyc.checkIncomingCredit(manager, ctx.userId, facts.netAmount,
                reader)                                   // takes the advisory lock FIRST, then evaluates
    verdict.allowed  -> ledger.postFundingWithinTransaction(manager, facts)   // today's postFundingEntries
    !verdict.allowed -> ledger.holdFundingWithinTransaction(manager, facts)   // section 3.1
  )
  after commit: publish events; if held, payments.initiateRefund(refundReference)
```

- `kyc.checkIncomingCredit(manager, userId, amount, readBalanceAndPending)` is new, non-throwing: `Promise<{ allowed: true } | { allowed: false; reason: 'zero_cap' | 'over_cap'; cap: Money; remaining: Money }>`. It calls `lockUser` first (`pg_advisory_xact_lock(hashtext(userId))`, the same lock `checkBalanceCap`, `checkAndReserveLimit` and `checkTransferLimits` take), then the existing cap logic. Implementation is a small refactor: split `checkBalanceCapLocked`'s evaluation into a function returning the verdict, with the existing methods wrapping it and throwing as now. `kyc` still imports only `users`.
- The reader is supplied by `payments` from `ledger` (the caller-supplies-the-ledger-facts pattern of ADR-0017). It must **exclude other pending fundings**: at completion the question is whether the credit fits the stored balance, and every other pending funding is checked by this same path when it completes. Counting them would hold a payment that fits (for example two fundings of 150k and 150k against a 300k cap, both fine at initiation). The existing `getBalanceAndPendingFunding` counts the funding being completed itself (still `pending`), so reusing it would double count. A balance-only read (new `ledger.getWalletBalance(manager, userId)`, or the existing method with `pending` zeroed) is what is needed.
- `ledger` gains the within-transaction variants (`postFundingWithinTransaction`, `holdFundingWithinTransaction`), mirroring `postTransferWithinTransaction`. The public `postFunding` keeps handling the non-credit cases (provider-failed outcomes, amount mismatch) in its own transaction.
- Lock order: advisory user lock first, then row locks by `account_id` ascending (float, suspense, fee pair, and the wallet when crediting). This is the order transfers already use (advisory locks before wallet rows), so it adds no new cycle.
- Webhook-path credits therefore now take the user lock, which closes the unlocked-credit race in #48. Credits that remain exempt and unlocked, by decision: withdrawal reversals and chargeback / chargeback-reversal postings (compensating). They can overshoot the cap by their own amount when racing a funding; this is recorded, not engineered around.
- Out-of-band bank credits: `postFunding` logs an error and returns `null` for an unknown reference, so money that arrives with no matching pending transaction is not credited today. It surfaces only as an external reconciliation mismatch. This design does not change that; it removes "out-of-band credit" from the cap-bypass list in #48 as far as the current code goes.

## 5. State machine and schema

`transactions.status` today: `pending, completed, failed, reversed, disputed`. `transactions.type` today: `funding, p2p_transfer, withdrawal, withdrawal_reversal, chargeback, chargeback_reversal, profit_withdrawal, bill_split, scheduled`.

Proposed additions (smaller than a status per refund phase, because the refund's own phase is carried by the attempt rows):

| Row | New values | Transitions |
|---|---|---|
| `funding` | status `held`, `refunded` | `pending` -> `completed` \| `failed` \| `held`; `held` -> `refunded`. (Existing `completed` -> `disputed` -> `reversed` unchanged; chargebacks apply to `completed` fundings only, never to `held`/`refunded`.) |
| `funding_refund` (new type) | uses `pending`, `completed`, `failed` | `pending` -> `completed` \| `failed`. One row per attempt: `reverses_transaction_id` = the funding row, `amount` = net, `provider = 'kora'`, `reference` = `provider_reference` = the refund reference, `metadata { attempt, failureReason?, initiatedAt? }`, no sender or recipient wallet. |

The suggested `refund_pending` / `refund_failed` funding statuses are avoided on purpose: "refund in flight" and "refund failed" are facts about the attempt row, and duplicating them on the funding row would need two writes kept in sync. `held` means exactly "money is in suspense awaiting resolution".

Migrations (each maps to a current need, added with the slice that needs it):

1. `AddSuspenseAccountRole`: widen `CHK_accounts_role`; seed the NGN/kora suspense row.
2. `AddHeldFundingStatusesAndRefundType`: widen `CHK_transactions_status` (add `held`, `refunded`) and `CHK_transactions_type` (add `funding_refund`), following `1787500000002-AddChargebackReversalTransactionType.ts`; and a partial index on `transactions (created_at) WHERE type = 'funding' AND status = 'held'` for the held-too-long and retry queries. The existing `IDX_transactions_stale_funding_poll (status, provider, type, created_at)` already serves the pending-refund poll. Neither migration touches `ledger_entries`.
3. Relations (ADR-0002): `funding_refund.reverses_transaction_id` already has the FK and a TypeORM relation on `Transaction`; no new FK is introduced.

`TransactionMetadata` (typed per transaction type, ADR-0008) gains `FundingRefundTransactionMetadata`; `FundingTransactionMetadata` gains optional `heldAt` and `refundAlertedAt`. `docs/architecture.md` §5 documents the enum changes.

## 6. Provider adapter

New methods on `PaymentProviderAdapter` (types in `payment-provider.interface.ts`, mirroring the payout trio):

```
initiateRefund(params: { reference: string; paymentReference: string; amount: Money; reason: string }): Promise<InitiateRefundResult>
verifyRefund(reference: string): Promise<VerifyRefundResult>

InitiateRefundResult =
  | { status: 'accepted' }                       // 200, data.status 'processing'
  | { status: 'already_exists' }                 // 409 AA021 "Refund already exists with reference"
  | { status: 'rejected'; reason: string }       // a recognised, confirmed rejection (4xx with a Kora code)
  | { status: 'unknown'; detail: string }        // network error, timeout, 5xx, unrecognised shape

VerifyRefundResult =
  | { status: 'success'; amount: Money }
  | { status: 'failed'; reason: string }
  | { status: 'pending' }
  | { status: 'not_found' }                       // 404 AA026 "Refund not found": never reached Kora
```

- `unknown` is never treated as `rejected`, the same reasoning as `InitiatePayoutResult`: Kora may have the request and have debited its balance. A caller resolves it through `verifyRefund`.
- `not_found` on a stale pending attempt means the post-commit initiate never reached Kora, so initiating again with the **same** reference is safe, and the duplicate-reference 409 (`already_exists`) makes a repeat harmless.
- The Kora adapter sends `{ payment_reference, reference, amount, reason }` and **no** `webhook_url`, `completion_status` or `status_reason`: the dashboard URL already points at the one endpoint and the verified signature path. Amount as a decimal number via `Money.toDecimalString()`, like the other calls. `payment_reference` is our funding reference (the charge reference sent to Kora), which `provider_reference` mirrors (ADR-0007).
- Mapping: HTTP 200 `status: true` -> `accepted`; 409 with `code AA021` and a message starting "Refund already exists" -> `already_exists`; 429 (cool-down) -> `rejected` with a retriable reason; other 4xx with a body -> `rejected`; everything else -> `unknown`. Status: `success` / `failed` / anything else `pending`; 404 `AA026` -> `not_found`; other non-2xx throws like `verifyCharge`.
- Webhook parsing: `handleKoraWebhook` gains `refund.success` / `refund.failed` branches calling `processRefundWebhookData`, with a `validateRefundWebhookData` guard like `validatePayoutWebhookData` (`reference`, `status`, `amount` required; `status_reason` optional). `verifyWebhookSignature` is unchanged. The new `ledger` lookups are scoped by `type = 'funding_refund'`, as `postFunding`'s are by `type = 'funding'`, so a mislabeled `event` can fail to match but never misapply.
- `FakeAdapter` (kept deliberately like the real scheme): `refundsInitiated` list; `setVerifyRefundResult(reference, result)` defaulting to `pending`; initiate sentinel by reference text like `payout` (`reject`, `unknown`) plus `setInitiateRefundResult`; `already_exists` on a repeated reference; and a helper to build a signed refund webhook body for integration tests.
- A contract spec `test/contract/kora-refunds.contract-spec.ts` (nightly, skipped without a sandbox key) asserts the recorded shapes from `test/fixtures/kora-refunds/` for initiate, status, the `AA021` and `AA026` errors, and that the webhook signature scheme still verifies. It creates its own bank-transfer charge (section 7 of the findings doc) so it needs no manual step.

## 7. Idempotency and races

Refund reference: `rfd-<funding transaction id (uuid, 36 chars)>-<attempt>` = 4 + 36 + 1 + 1 to 2 digits, at most 44 characters, under Kora's 50 (a 64-character reference gave an HTTP 500 in the sandbox). Derived from the ledger row id, not the client-supplied funding reference, which is allowed up to 100 characters (`FundWalletDto`). It is deterministic: the same funding and attempt always give the same reference. The same string is the `funding_refund` row's `reference` (globally unique) and `provider_reference` (ADR-0007), so the webhook's `data.reference` resolves straight to the row.

| Situation | Behaviour |
|---|---|
| `charge.success` webhook delivered twice | Both enter `completeFunding`; the advisory lock serialises them; the first flips the row, the second finds `status != pending` (guarded UPDATE affects 0 rows) and returns `null`. No second hold, no second refund row. |
| Webhook and funding poll race | Same: both go through `completeFunding` and the same lock; one wins. |
| Process dies after the hold commits, before `initiateRefund` | The attempt row is already `pending` and committed. The refund poll finds it stale, calls `verifyRefund`: `not_found` -> initiate again with the same reference. |
| `initiateRefund` returns `unknown` (timeout) | Leave the row `pending`; the poll resolves it with `verifyRefund` (`pending`/`success`/`failed`/`not_found`). Never re-initiate on `unknown` without verifying first. |
| `refund.success` delivered twice, or webhook then poll | `settleRefund`'s guarded UPDATE `pending` -> `completed` affects 0 rows the second time: no second posting. |
| `refund.failed` after the poll already failed the row, or after success | Guarded the same way; a failure arriving for a `completed` row is logged as an anomaly. |
| Late `refund.success` for an attempt whose row is `failed` (a retry already created) | The posting guard is on the funding row `held` -> `refunded`; if the funding is still `held`, the late success is the true outcome: settle it, and cancel the pending retry row (`failed`, reason `superseded`). If the funding is already `refunded` it is an anomaly alert (possible double refund at Kora). |
| Two refund attempts for one funding | Creating attempt n+1 locks the funding row `FOR UPDATE`, requires status `held`, no `pending` attempt row and exactly n existing rows; the unique reference blocks a duplicate even so. |
| A refund event for an unknown reference | Logged at error; nothing posted; HTTP 200 so Kora stops retrying (as `postFunding` does for an unknown funding reference). |

The refund-initiate call runs after commit, never inside the transaction (CLAUDE.md), and so do the domain events.

## 8. Notifications

New domain events (`src/shared/events/domain-events.ts`, payloads accumulating as needed), catalog entries and templates:

- `FUNDING_HELD_EVENT` (type `funding_held`, channels `['email', 'in_app']`, like `funding_completed`), published after the hold commits: "Your payment of NGN X could not be added because it would take your wallet over its limit of NGN C. We are refunding it to the account you paid from; the payment provider's fee is not refunded. To raise your limit, verify your identity." Payload: `userId, email, amount, currency, reference, cap`.
- `FUNDING_REFUNDED_EVENT` (type `funding_refunded`, same channels), published when the refund settles: "NGN X has been refunded."
- Ops alert `refund_attention_required` (email only, no `userId`, so the compile-time rule keeps it out of `in_app`), addressed to the existing `RECONCILIATION_ALERT_EMAIL` (no new config), payload `{ email, reason: 'retries_exhausted' | 'held_too_long' | 'late_success_after_refunded' | 'amount_mismatch', fundingReference, refundReference?, amount, currency, heldSince, attempts, lastFailure?, occurredAt }`.

In-app notifications need a `dedupe_key`; use the funding reference. Copy states how to raise the limit by verifying identity (the tier model's balance caps). No push channel, as with other money events in this phase (not scaffolded ahead of need).

User-visible gap to decide: the wallet history (`getTransactionHistory`) is built from `ledger_entries` on the user's wallet, so a held or refunded funding, which has no wallet entry, does not appear there (pending fundings do not appear either). See open question 7.

## 9. Automatic recovery and reconciliation

### 9.1 The refund poll

New `RefundPollProcessor` in `src/modules/payments/internal/refund-poll.processor.ts`, a copy of `FundingPollProcessor`/`WithdrawalPollProcessor`: its own queue `refund-poll`, `upsertJobScheduler('poll-stale-refunds', { every: 5 min })` in `onModuleInit`, `process()` calling `PaymentsService.pollStaleRefundTransactions()`; queue registered in `PaymentsModule` with the same `defaultJobOptions`. Per run, sequentially:

1. **Resolve stale pending attempts** (`funding_refund`, `pending`, older than 5 minutes): `verifyRefund`. `success` -> `settleRefund`; `failed` -> `failRefund`; `pending` -> leave; `not_found` -> `initiateRefund` again (same reference); a thrown error -> log and retry next run, as the existing polls do. Sandbox refunds finish in about a second, so 5 minutes is generous; live `processing` time is unknown (question 4 to Kora).
2. **Start retries** for held fundings whose latest attempt `failed`, no attempt `pending`, attempts below the maximum, and the gap since that failure elapsed.
3. **Alert** (section 9.3).

Integration specs for it use `closeBullmqWorkers(app)` from `test/integration/support/bullmq-teardown.ts` (it discovers every `WorkerHost`, so the new processor needs no list change) and the same pattern as `payments-funding-poll.integration-spec.ts`.

### 9.2 Bounded retry policy (named constants in `payments`, not config, like the existing stale thresholds)

| Attempt | Earliest start |
|---|---|
| 1 | right after the hold commits |
| 2 | 10 minutes after attempt 1 failed |
| 3 | 1 hour after attempt 2 failed |
| 4 | 6 hours after attempt 3 failed |
| 5 | 24 hours after attempt 4 failed |

At least 10 minutes is far above Kora's roughly 60 s per-payment cool-down. After attempt 5 fails the funding stays `held`, retries stop, and the `retries_exhausted` alert fires. A new reference per attempt is mandatory (a burnt reference returns 409). The numbers are proposals (question 4).

### 9.3 Alerts and held-too-long

- `retries_exhausted`: when the last allowed attempt fails.
- `held_too_long`: any funding `held` for 24 hours without reaching `refunded`, whatever the attempt state (this also catches a refund that stays `pending` at Kora). Repeats every 24 hours while unresolved. De-duplication: `FundingTransactionMetadata.refundAlertedAt` is merged when an alert is sent (the `mergeTransactionMetadata` pattern), and the poll only alerts when it is absent or older than 24 hours.
- A refund attempt rejected for a reason that looks like insufficient Kora balance (text unknown) is just a `failed` attempt with its `reason` captured in the alert; no special state.
- The alert follows the `reconciliation_mismatch` pattern exactly: `eventBus.publish` after the work, a catalog entry, an email template, same recipient. Held money is a real liability; hence the repeat.
- A stuck funding needs an operator action (refund manually in the Kora dashboard and then post the settlement; or, if the user has since upgraded, release the suspense to the wallet: `DR suspense / CR wallet`). That ops path is not designed here (question 6); the data model supports it with a compensating transaction.

### 9.4 Reconciliation and the invariant

- `reconcilePair` today compares `float` against Kora's available plus pending balance. Because Kora debits at initiate time, the provider balance is lower than float by the amount of any refund initiated but not yet settled. Add `ledger.getInFlightRefundTotal(provider, currency)` (sum of `pending` `funding_refund` rows whose `metadata.initiatedAt` is set, which `payments` records when `initiateRefund` returns `accepted` or `unknown`) and compare `float - inFlight` to the provider balance. Rows not yet initiated are excluded, so a row created at hold time with no Kora call yet does not skew it.
- `ledger.getSuspenseBalance(provider, currency)` is added and included in the debug log line and in `ReconciliationMismatchEventPayload` (new `suspenseBalance`, `inFlightRefunds` fields, shown in the template) so a mismatch can be read against what is owed back.
- The internal invariant test helpers and the property test get the suspense term (section 13). There is nothing to change in a production invariant check because none exists.

## 10. Posting detail for existing paths

- `postFunding` stays the single place funding entries are posted (ADR-0008); it gains the hold variant. The amount-mismatch guard (`facts.netAmount.amount !== transaction.amount`) stays ahead of both: a mismatch fails the funding as today and neither credits nor holds.
- `pollFundingTransaction` and `processFundingWebhookData` change to call `completeFunding` for the `success` outcome; `failed` outcomes keep calling `postFunding` as today.
- Initiation (`fundWallet`) is unchanged: the cap is still checked there, which stays the primary defence. The 24-hour window of #47 is what makes a late payment reach the hold path: a checkout paid more than 24 hours after initiation no longer reserved headroom.

## 11. Security and abuse

- Webhook authenticity: signature verified exactly as for charges and payouts (verified against captured refund deliveries). The refund success amount is cross-checked against the row; lookups are type-scoped.
- Can a user cause refunds repeatedly for cost? What a held payment costs under each fee option: option N costs Cliqpay no provider fee (the payer bears it) and, as far as the sandbox shows, no refund fee; option G costs the pay-in fee per refunded payment (NGN 53.75 on NGN 1,000 for a bank transfer in the sandbox; the ADR-0007 card samples were 13.97 on 1,000 and 34.94 on 2,500). How a user could get there at all: initiation rejects an over-cap funding, and counted pendings reserve headroom against transfers, so a hold needs (a) a checkout paid after the 24-hour window, or (b) an exempt credit (reversal) landing in between. A user can repeat (a): initiate a checkout, let it age past 24 hours, initiate another, pay both. That is one refunded payment per 24-hour cycle per pending slot, bounded by the number of checkouts the user can create (the initiation check counts pendings, and each pending sits on the cap headroom for 24 hours, so a user near the cap can only keep a few). With N this costs Cliqpay nothing; with G it would be a slow, bounded drain. Mitigation if G is ever chosen: do not release a pending's headroom reservation at 24 hours without also expiring the checkout, or cap refunds per user per day with an alert. Not needed for N.
- Information: the refund email is addressed to the payer (the wallet owner); it states the cap, which the user can already read from `GET /kyc/status`.
- Money safety: nothing is credited before the check; a crash between hold and refund leaves money in suspense with a durable attempt row, recoverable by the poll; no code path posts the refund settlement without Kora reporting success.
- Provider cost of failures: a failed refund moves no money in the sandbox; live behaviour unknown (question 4).

## 12. Edge cases

1. **Below the NGN 100 minimum.** Kora documents a NGN 100 minimum; the sandbox accepted 99.00 and nothing is known for live. There is no minimum funding amount today (`FundWalletDto` only requires a positive integer). Recommendation: enforce a NGN 100 minimum at initiation (slice 8), so a refund below the minimum can never be needed. Fallback if not: treat a held funding below NGN 100 as `rejected` and let it follow the retry policy to the ops alert.
2. **Kora's own balance too low to refund.** Not observable in the sandbox. Expected to come back as a rejection; the attempt fails, the retry policy spaces retries, and the alert tells operations to top up float. The invariant is unaffected: money stays in suspense. (The external reconciliation would also be showing the shortfall as float versus provider.)
3. **Several fundings held at once.** Independent rows; each has its own attempts and alert.
4. **Tier changes during the hold.** The check is evaluated once, at completion. A user who upgrades after a payment was held still gets the refund (decision: no grace period). A grace window is possible later (question 8).
5. **Chargeback on a held or refunded funding.** Not possible: `disputes` rejects any status outside `CHARGEBACKABLE_STATUSES` (`disputes.service.ts`), which `held` and `refunded` are not, and such a funding never credited the wallet. No code change; slice 3 adds a test that a chargeback against a `held` funding is refused.
6. **A payment held but the wallet has since been frozen.** Funding ignores freeze by design (ADR-0016); the check does too.

## 13. Tests

Unit: `kyc.checkIncomingCredit` (allowed, zero cap, over cap, exactly at cap, `balanceCapMinor = null` is always allowed); refund-reference derivation (length at most 50 for attempts up to 99); retry schedule; Kora adapter mapping of every captured fixture (`accepted`, `already_exists`, `rejected` for 409 `AA021` variants and 422 `AA025`, 429 as retriable rejection, `unknown` for 500 and timeouts, `verifyRefund` success/failed/processing/`not_found`); `validateRefundWebhookData`; the Fake adapter.

Integration (real Postgres via Testcontainers, scoped files per feature area, shared support module):
- `ledger-funding-hold.integration-spec`: hold posts exactly the section 3.1 entries; settle posts (ii); failure posts nothing; retry then success; the invariant (with suspense) holds after each; cached balances equal summed entries for float, suspense and wallet.
- `payments-funding-cap-at-completion.integration-spec`: webhook over the cap -> held, wallet not credited, one refund row, suspense equals the amount; exactly at the cap -> credited; poll path does the same; duplicate webhook twice -> one hold; webhook and poll together -> one hold.
- **Concurrency (the heart of #48):** a funding older than 24 hours (not counted at initiation) completing while a P2P transfer to the same user is in flight, with headroom for only one: run concurrently, repeat, assert the wallet is never above the cap and exactly one of the two lands; same with two fundings completing together; and a withdrawal in flight. Use `test/integration/support/user-lock.ts` the way `ledger-transfer-concurrency.integration-spec.ts` does. Mutation proofs recorded in the PR: remove `lockUser` from `checkIncomingCredit` -> the concurrency test must fail with an overshoot; skip the status guard in the hold -> the duplicate-webhook test must fail with a second hold; omit the suspense term from the invariant helper -> a hold test must fail.
- `payments-refund-webhook.integration-spec`: signed `refund.success` settles, `refund.failed` fails the attempt, invalid signature 401, unknown reference ignored, duplicate delivery no double posting, mismatched amount left pending.
- `payments-refund-poll.integration-spec`: stale pending resolved by `verifyRefund` for each outcome including `not_found` re-initiating with the same reference; retries follow the schedule and stop at attempt 5 with the alert; `held_too_long` fires once per 24 hours; uses `closeBullmqWorkers`.
- `payments-reconciliation.integration-spec` extended: float minus in-flight refunds versus provider balance; the mismatch alert carries suspense and in-flight figures.
- Property-based (`fast-check`, in `ledger-funding-invariant.integration-spec.ts`, same `FC_NUM_RUNS` convention): the operation generator gains `holdFunding`, `settleRefund`, `failRefund` and `retryRefund` alongside funding, transfer and withdrawal; after every operation the invariant including suspense holds, caches equal summed entries, and no wallet funded through the hold path exceeds its cap. Higher-iteration fuzz nightly as per the testing strategy.
- A contract spec (above) for the adapter shapes.

No test is written for pure config wiring (the memory rule); there is no new config here.

## 14. Documentation to update

- `docs/architecture.md`: version note (v14) and change summary; §3.5 user-level lock note (the webhook completion path takes it); §4.1 account table (add `suspense`) and the account roles; §4.2 add the held-funding and refund postings and the fee treatment; §4.3 the invariant; §4.4 the in-flight and suspense wording; §5 schema (role, type, status enums, new metadata); §6 Phase 2 (refunds as the cap-breach path) and the Phase 6 balance-cap bullet, replacing "explicitly out of scope" with what was decided, and the late-payment trade-off sentence; §7 data integrity (suspense).
- `docs/adr/0017-...`: replace the "still out of scope" sentences with a pointer to ADR-0021; add a note recording the raced-twin transfer replay (returns the twin's committed result without re-running the recipient check, which is correct because it is the same transfer), the third known gap in #48.
- `docs/adr/0008-...`: one line in Consequences that refund settlement is a ledger posting rule and the refund call is a payments concern.
- `docs/e2e-real-providers.md`: the bank-transfer API as a way to complete a sandbox charge with no UI, and the refund notes.
- `test/contract/README.md`: the Kora refunds spec.
- `CLAUDE.md`: nothing (no new rule); the invariant line in the non-negotiable rules gains `+ suspense` when the first slice lands.

## 15. Proposed issue breakdown

Not published. Each is a vertical slice, demoable on its own with `FakeAdapter`.

| # | Title | Blocked by |
|---|---|---|
| 1 | Record the Kora refund findings and the hold-then-refund ADR (docs, fixtures, architecture.md updates, issue #48's ADR criterion) | none |
| 2 | Suspense account and the ledger hold/settle/fail postings (migrations, seed, `holdFundingWithinTransaction`, `settleRefund`, `failRefund`, invariant and property test extended) | 1 |
| 3 | Check the balance cap, under the user lock, when a funding completes (`kyc.checkIncomingCredit`, `PaymentsService.completeFunding` for webhook and poll, hold on breach, concurrency tests) | 2 |
| 4 | Refund a held funding through Kora and tell the user (`initiateRefund`/`verifyRefund` on both adapters, refund webhook handling, post-commit initiation, user events and templates, contract spec) | 3 |
| 5 | Recover stuck refunds automatically (refund poll processor, bounded retry, ops alerts) | 4 |
| 6 | Reconciliation accounts for held money and in-flight refunds (report, adjusted comparison, alert fields) | 4 |
| 7 | Show held and refunded payments in wallet history | 4 |
| 8 | Enforce a NGN 100 minimum funding amount at initiation | 1 (needs question 3 answered) |
| 9 | Verify refunds against hosted-checkout card and transfer charges and revisit the provider-fee treatment (human-in-the-loop) | 1 |

Acceptance criteria are written per issue in the style of #40 to #58 (what to build, decisions to confirm, behaviour, a checklist) in the final report of this research session; they are not duplicated here to avoid drift.

## 16. Open questions and recommendations

1. **Fee treatment: refund the principal (N) or the gross (G)?** Recommend N, provisional. Settle it with the manual checkout and card test (kora-refunds.md section 9) and Kora's answers before slice 4 ships to anything real.
2. **What does "full refund" mean to the user?** Recommend: the credited amount, with the provider fee kept by Kora and stated in the email. The alternative is G and its cost.
3. **Minimum funding amount NGN 100?** Recommend yes (slice 8): it removes a case this design would otherwise need a fallback for.
4. **Retry policy numbers** (5 attempts: 0, +10 min, +1 h, +6 h, +24 h; 24 hours to the held-too-long alert; 5-minute poll)? Recommend as proposed; they are constants and cheap to change.
5. **Alert recipient:** reuse `RECONCILIATION_ALERT_EMAIL`? Recommend yes; no new config until a different recipient is needed.
6. **Operator tooling for a funding stuck after retries** (manual refund then settle; release to wallet after an upgrade)? Recommend a separate issue after slice 5; until then the alert and the data are enough for a rare event.
7. **Wallet history for held/refunded payments?** Recommend slice 7 right after slice 4, so a user who is refunded can see why.
8. **Grace window instead of an immediate refund** (let the user verify within N minutes and be credited instead)? Recommend not now: the decision was hold then refund; revisit if refunds turn out to be frequent.
9. **Send `webhook_url` on the refund?** Recommend no: the dashboard URL reaches the same verified endpoint, and one URL is one place to monitor.
10. **Does the user also want the held funding visible to ops before an alert** (a collections-style internal list like `disputes`' view)? Recommend defer; the alert plus a query is enough at this volume.
