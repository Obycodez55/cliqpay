# ADR-0033: Scam reports hold the reported amount in a `fraud_hold` account until a reviewer decides

**Status:** accepted
**Date:** 2026-11-09

## Context

A P2P transfer has no automatic reversal. Authorised push payment (APP) fraud,
where a victim is talked into sending money, is the dominant social-engineering
loss in Nigeria. The CBN's draft guidelines (FPR/DIR/PUB/CIR/001/010, Nov
2025) set the expectations:

- a 24/7 reporting channel including the mobile app; the customer is expected
  to report within 24h and has up to 72h for reimbursement eligibility;
- acknowledgement within 24h with a case reference and timelines;
- investigation concluded within 14 working days, reasons given on denial;
- the receiving institution red-flags and restricts; an institution that fails
  to flag or freeze proceeds bears the full loss, and with no one at fault the
  sending and receiving institutions split it;
- reimbursement within 48h of concluding a documented investigation.

On a Cliqpay P2P transfer, Cliqpay is both the sending and the receiving
institution.

Freezing the recipient on a report would make reporting a harassment tool:
send someone ₦100, report it, and their account is locked.

## Decision

**Who can report.** The sender of a completed P2P transfer (including a paid
money request), once per transfer, rate-limited per user, up to 30 days after
it. Reports after 72 hours are marked `late`, which affects reimbursement, not
investigation. Fields: category (impersonation, fake goods or services,
investment, romance, other), description, optionally how the recipient
contacted them. Scams paid out through a withdrawal are out of scope: Kora
offers no way to freeze funds at the receiving bank, so those go to support.

**Acknowledgement is immediate.** A case reference (`SCM-000123`), the
14-working-day `dueAt`, and the next steps, in-app.

**The hold.** In the report's transaction, `min(transfer amount, recipient's
balance)` moves from the recipient's wallet to a new `fraud_hold` liability
system account (per currency, provider-agnostic like `fee_income`), as a new
`fraud_hold` transaction. It never takes a balance negative; a shortfall is
recorded on the case. Locks follow the usual ascending `account_id` order.

**The recipient is flagged.** An enforced `scam_report` flag holds their
withdrawals (ADR-0032), and `tainted_inflow` holds the withdrawals of anyone
they forwarded money to. Repeat reports add to the flag's `hitCount`. Two or
more distinct reporters within 30 days adds a `fraud` restriction (outbound)
pending review.

**The recipient is told.** "₦X of your balance is on hold while we review a
transfer you received." They can submit their side as text on the case. The
sender's identity is already on the transfer, and this is a fraud dispute, not
AML, so there is no tipping-off concern.

**Resolution.**

| outcome | posting | flag |
|---|---|---|
| `upheld` | `scam_recovery`: `fraud_hold` → reporter's wallet | `confirmed`, adds `fraud` restriction |
| `rejected` | `fraud_hold_release`: `fraud_hold` → recipient's wallet | `cleared`; lifts the case's pending restriction |
| `withdrawn` (by reporter, before a decision) | as `rejected` | as `rejected` |

The reporter is given the reason on denial. A decided case is never reopened;
a new report is a new case. Every step is audited (ADR-0030).

**Deadlines.** `dueAt` counts weekdays only; public holidays are treated as
working days, which is conservative. A case open 2 working days before `dueAt`
alerts ops. Nothing closes automatically.

**Reimbursement of the shortfall is not built.** The case stores
`reportedAmount`, `heldAmount`, `recoveredAmount` and a nullable
`reimbursedAmount`, so paying an unrecovered loss from Cliqpay's own funds
later is a new posting rule (a `fraud_loss` expense), not a schema change.
Whether to do so is a pre-launch decision tied to the final CBN guideline.

## Alternatives considered

- **Freeze the recipient's account on a report.** Weaponisable by anyone
  willing to send a small amount.
- **Hold the amount without moving it (an available-balance overlay).** A
  second notion of balance outside the ledger, and every limit and display
  would have to learn it. A posting keeps `balance` meaning what it says.
- **Hold along the whole chain of recipients.** `tainted_inflow` holds the
  next hop's withdrawals, which is where the money would leave, without
  liening wallets that may be innocent.
- **Reimbursing shortfalls now.** A loss budget and a regulator's final rules
  should decide this, not a schema.

## Consequences

- Ledger gains a `fraud_hold` system account and three transaction types
  (`fraud_hold`, `fraud_hold_release`, `scam_recovery`); the §4.3 invariant
  covers them unchanged.
- `risk` owns the scam case table and calls `ledger` for the postings.
- Recipients can see held amounts in their history.
- Returns to the CBN (quarterly APP figures) can be produced from the case
  table when needed.

## Decisions made building scam reports

- **The hold is one posting per case, named after it.** The three transactions
  have references `SCM-000123-hold`, `-release` and `-recovery`, so a repeated
  call collides on the unique reference rather than moving money twice. Release
  and recovery point `reversesTransactionId` at the hold. `ledger` skips a
  posting of zero (a recipient with nothing left), so there is no empty entry.
- **`fraud_hold` is a single row per currency.** Every hold, release and
  recovery locks it, so they serialise globally, like `fee_income` at a
  non-zero fee. A posting locks the wallet and `fraud_hold` in ascending
  `account_id` order and never takes either below zero.
- **Only the recipient's user lock is taken.** The reporter's wallet is
  credited by recovery with just its row lock, as a withdrawal reversal is, so
  no second user lock is needed and no ordering question arises. A report, a
  response, a withdrawal by the reporter and a resolution all take the
  recipient's lock first, then the case row.
- **Recovery is exempt from the balance cap and not inflow.** Like a withdrawal
  reversal, `scam_recovery` and `fraud_hold_release` post without a cap check,
  and `getReceivedSince` counts only fundings and P2P transfers, so they never
  count toward the new-account inflow cap. A recovery can leave the reporter
  over their tier cap by its own amount, as a reversal can.
- **`scam_report` is a `fraud_rules` row** (mode `enforce`, params
  `minDistinctReporters` 2 and `windowDays` 30), so the flag and the restriction
  follow the usual modes: `off` raises neither, `shadow` raises an unenforced
  flag and no restriction. The hold itself always happens.
- **One flag stands for all open cases against a recipient.** A rejected or
  withdrawn case clears it only when no other case is open, so their
  withdrawals stay held; an upheld case confirms it whatever else is open.
- **The restriction follows the open reporters.** The report that reaches two
  distinct reporters with open cases in the window adds a `fraud` outbound
  restriction sourced to its own case (`restrictionAdded` on the case). When a
  case is rejected or withdrawn and the open cases no longer reach the
  threshold, every pending restriction of that kind for the recipient is lifted.
  An upheld case's restriction is its own and is never lifted by this.
- **Reporters never see the held amount.** `min(amount, balance)` would let a
  reporter read a recipient's balance, so the reporter's responses carry the
  reported and recovered amounts only. Reviewers see the held amount and the
  shortfall.
- **A report is addressed by transaction id,** the id history already returns,
  because a scheduled payment's reference is hidden from its recipient and a
  non-sender gets the same 404 as a missing transfer.
- **Rate limit:** 5 reports per user per hour, counted per attempt.
- **Notifications.** The recipient hears of the hold by email, push and in-app;
  both parties hear of a decision. A recipient with nothing to hold is told the
  transfer is under review. Neither message names the other party's balance.
- **Ops alert.** The existing 6-hourly job also calls `alertCasesDue`, which
  emails the reconciliation alert address a second digest (its own template, so
  the review-overdue one is untouched) listing open cases due within two
  working days or overdue. It keeps no state and decides nothing.
- **Working days are UTC weekdays.** `dueAt` is 14 weekdays after the report;
  the alert threshold is two weekdays before it.
