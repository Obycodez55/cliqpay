# ADR-0028: Scheduled payments are a peripheral module that drives standing-authorised transfers and withdrawals from a database-owned run table

**Status:** accepted
**Date:** 2026-11-08

## Context

Phase 9 (docs/architecture.md §6) automates payments: a one-time future
payment, recurring payments, retries and notifications on failure, cancel and
modify, and an audit log of every execution. The phase had not had a design
pass since v1.

What the codebase already gave us:

- Every money movement verifies the transaction PIN at the moment it moves
  (`TransfersService.finalizeTransfer`, `WithdrawalsService.initiateWithdrawal`).
  A scheduled run has no user present to enter one.
- A withdrawal is posted to the ledger synchronously, before Kora is called.
  Asynchronous settlement (webhook, poll, `unknown` outcome, reversal) is
  already owned by `withdrawals`, which publishes `withdrawal_completed` and
  `withdrawal_failed`.
- `transactions.reference` is globally unique, with sender-scoped replay and a
  request fingerprint (ADR-0010). A withdrawal rejected synchronously is
  posted then reversed, and replaying its reference returns "already
  rejected", so a retry can never reuse it.
- Background work runs as BullMQ repeatable jobs (`upsertJobScheduler`), and
  the event bus fans out to one queue per subscriber (ADR-0026).
- Africa/Lagos is UTC+1 with no DST; `kyc` already computes the Lagos day
  without a date library.
- `eslint-plugin-boundaries` already declares `scheduling` a peripheral
  element, so core modules importing it fails lint. The rule works on
  modules, not methods: it can't restrict which module calls a given method
  of an exported service.

## Decision

**Scope.** A schedule pays one target: another Cliqpay user (P2P) or one of
the sender's saved bank accounts. P2P is built first; bank targets follow as
their own slice. Scheduling the payment of an existing money request is out of
scope.

**`scheduling` is peripheral.** It depends on the exported services of
`transfers`, `withdrawals`, `users` and `kyc`, and nothing on the money path
consults it. If it disappeared, live payments would be unaffected.

**Authorisation is a standing mandate.** The PIN verified when a schedule is
created authorises every run of it. `TransfersService` and
`WithdrawalsService` each gain one exported method for scheduled execution
that skips only the PIN check; freeze, verified email, KYC limit reservation,
blocks, balance and the recipient's balance cap are all still checked on every
run. The method takes `{ scheduleId, runNumber }` and records both on
`transactions.metadata`. Core modules can't import a peripheral one, so it
cannot verify the schedule exists; it is guarded by convention instead: no
controller calls it, its name and doc comment say what it is, and an
integration test asserts no HTTP route reaches it.

- Re-verify the PIN to change amount, interval, next run date or end
  condition, or to resume. No PIN to pause, cancel, or edit note/visibility:
  stopping money must never be harder than starting it.
- Changing or resetting the PIN does not affect existing schedules, and a PIN
  lockout does not stop runs.
- No extra step-up for bank-target schedules: the account had to pass step-up
  to be saved. Instead, every create and every PIN-gated change notifies the
  sender by email and in-app.
- Security events (new session, PIN lockout, email/phone change) do not pause
  schedules.

**Runs post as existing types.** A P2P run is a `p2p_transfer`, a bank run a
`withdrawal`, so posting rules, fees, the §4.3 invariant, the daily-limit sum,
history and withdrawal reconciliation all apply unchanged. `scheduled` stays
reserved and unused in the `transactions.type` CHECK, as `bill_split` does.

**The database owns what is due.** Each schedule has `next_run_at`, with a
partial index `WHERE status = 'active'`. A BullMQ repeatable job runs every
`SCHEDULED_PAYMENT_SWEEP_INTERVAL_MS` (60 000). Each tick, in one transaction,
it selects due schedules `FOR UPDATE SKIP LOCKED`, inserts a
`scheduled_payment_runs` row per due run (unique on
`(schedule_id, run_number)`) and advances `next_run_at`. After commit it adds
one job per run to the `scheduled-payment-runs` queue with
`jobId = <scheduleId>:<runNumber>`. A worker with capped concurrency
(`SCHEDULED_PAYMENT_WORKER_CONCURRENCY`) executes it. Each tick also
re-enqueues `pending` runs whose attempt is due and that have had no job for a
few minutes, which recovers a crash between commit and enqueue; the fixed
`jobId` makes that safe. Claims are not batched for now.

**Idempotency per attempt.** The reference is
`sched_<scheduleId>_<runNumber>_<attempt>`. The attempt number advances only
once the previous attempt is confirmed not to have posted (a business failure
thrown before posting, or a synchronously reversed withdrawal). After a crash
with an unknown outcome, the retry reuses the same reference, gets a replay
match, and records the original transaction. The `sched_` prefix is reserved:
client-supplied references starting with it fail validation.

**Date-based runs in a morning window.** The user picks dates, not times. At
creation a schedule gets a fixed `run_offset_minutes` in
`[0, SCHEDULED_PAYMENT_WINDOW_MINUTES)`, and a run's `due_at` is
`SCHEDULED_PAYMENT_WINDOW_START` (06:00) Lagos on its date plus that offset.
This spreads payday load across 06:00–10:00 and leaves the rest of the day for
retries. The first run is tomorrow at the earliest; a start date at most one
year ahead.

**Recurrence.** `interval_unit` (`day | week | month`) and `interval_count`
(1–365 days, 1–52 weeks, 1–12 months), or neither for a one-time schedule. Run
dates are computed from the stored anchor, never from the previous run:
run *n* is `start_date + (n - anchor_run_number) × interval`, with month steps
clamped to the month's last day, so Jan 31 → Feb 28 → Mar 31. Changing the
next run date re-anchors (`start_date` = the new date, `anchor_run_number` =
the next run number). One optional end condition: `end_date` (inclusive) or
`max_runs` (1–366), counting every run including failed, missed and reversed
ones. A schedule that reaches it becomes `completed`. The date arithmetic is a
pure function, test-first, with no new dependency.

**Failures.**

| class | failures | handling |
|---|---|---|
| transient | insufficient balance, daily limit exceeded, recipient balance cap, payout rejected synchronously | retry the same day |
| permanent | blocked either way, recipient unavailable, bank account removed, sender frozen | run fails, schedule pauses at once |
| infrastructure | DB/Redis errors, timeouts, crashes | BullMQ's own fast retries first, then treated as transient |

- Up to 4 attempts per run, at +2h, +4h and +6h after the first, all inside
  the Lagos day: a run that slipped past midnight would count against the next
  day's KYC limit. After the last, the run is `failed`, the sender is
  notified, and the schedule continues.
- 3 consecutive failed or reversed runs pause the schedule. Only `succeeded`
  resets the count. Resume starts from the next future date and never runs
  missed ones.
- Only the sender is notified, and only on final outcomes, never per attempt.

**Missed runs.** A run due earlier today is executed late with whatever
attempts still fit before Lagos midnight. A run whose date has already passed
is recorded `missed` with a `missed` attempt row and no execution, and the
schedule advances; several missed runs each get a row, and the sender gets one
summary per schedule. A run whose day ends before it can execute is never paid:
with no attempts it is `missed`, with attempts it fails with its last failure.
Missed runs count toward `max_runs` but not toward the consecutive-failure
pause, since the outage was ours.

**Run states.** `pending` → `succeeded` (P2P) or `pending` → `settling` →
`succeeded` | `reversed` (bank); also `failed`, `missed`, and `cancelled`
for a `pending` run whose schedule was cancelled. Every bank run
sits in `settling` until `withdrawals` resolves the payout: accepted and
`unknown` outcomes both go there. `scheduling` subscribes to
`withdrawal_completed` and `withdrawal_failed`, matching the `sched_`
reference prefix. `reversed` counts toward the pause rule and is not retried.
No extra notification: `withdrawal_failed` already tells the user. A
`settling` run does not block the next run, and `scheduling` never times one
out itself.

**Audit.** Four tables. `scheduled_payments` and `scheduled_payment_runs`
hold mutable current state. `scheduled_payment_attempts` (one row per attempt
plus `missed`, `settled` and `reversed` outcome rows) and
`scheduled_payment_changes` (created, updated with before/after jsonb,
paused, resumed, cancelled, completed, with actor `user | system` and a
reason) are append-only, enforced by triggers like `ledger_entries`. The runs
and their attempts are exposed; the change log is internal.

**Snapshots.** A run row copies amount, target, note and visibility when
it is created, and every attempt uses the copy. Edits apply from the next run.
The payee is not editable; changing who is paid means cancel and create.
Edits lock the schedule row `FOR UPDATE`; the sweep's `SKIP LOCKED` picks the
row up on the next tick. Cancel cancels any `pending` run; an attempt already
executing finishes.

**Creation rules.** KYC Tier 1+, verified email, not frozen. Amount at least
the transfer (or withdrawal) minimum and at most the sender's current daily
limit. P2P: recipient wallet exists, not self, not blocked either way, and an
advisory `checkCanReceive`. Bank: the account is saved and owned by the
sender. At most `SCHEDULED_PAYMENT_MAX_ACTIVE` (20) active or paused
schedules. No balance check. A client `reference`, unique per user, makes
create idempotent (same contents replays, different contents 409). Note
follows transfer rules (optional, 1–500). Visibility is required for P2P
targets and forbidden for bank targets; each run's post uses it like a live
send. Runs are plain transfer posts, with nothing marking them as scheduled.

**Visibility of schedules.** Only the owner. Recipients are never told a
schedule exists.

**Notifications.**

| event | channels | when |
|---|---|---|
| `scheduled_payment_created` | email, in-app | create |
| `scheduled_payment_updated` | email, in-app | a PIN-gated change |
| `scheduled_payment_run_failed` | push, in-app | a run's final attempt fails |
| `scheduled_payment_paused` | push, email, in-app | the system pauses a schedule |
| `scheduled_payment_runs_missed` | push, in-app | runs skipped after downtime |
| `scheduled_payment_upcoming` | push, in-app | the evening before a run, only if the wallet balance is below the run amount |

The upcoming check is a daily repeatable job at 18:00 Lagos. It records the
run date it warned about on the schedule, in the transaction that decides to
send, so a re-run or a second instance never warns twice. Successful runs
use the existing transfer and withdrawal notifications. User-initiated pause
and cancel, and normal completion, send nothing.

**API.** `POST /scheduled-payments` (PIN), `GET /scheduled-payments?status=
active|paused|ended` (keyset on `(created_at, id)`, 20 default / 50 max),
`GET /scheduled-payments/:id`, `PATCH /scheduled-payments/:id` (PIN when a
money-affecting field is present), `POST /:id/pause`, `POST /:id/resume`
(PIN), `POST /:id/cancel`, `GET /:id/runs` (newest first, attempts nested).
Anyone but the owner gets 404.

## Alternatives considered

- **P2P only.** The bank target turned out cheap, because withdrawals already
  post synchronously and own settlement, and paying rent or fees to people
  not on Cliqpay is likely the more valuable case.
- **Paying an existing money request on a date.** Races the request's 7-day
  expiry, and paying it manually already exists.
- **Per-run confirmation by push and PIN.** Safer, but turns automation back
  into a reminder.
- **Step-up on bank-target schedule creation.** Duplicates the gate already on
  saving the account, for one more round-trip.
- **Pausing schedules on security events.** Alerts are untyped free text, and
  pausing someone's rent because they logged in on a new phone is worse than
  the risk, since an attacker gains from creating schedules, not from existing
  ones.
- **Standing-authorisation tables inside `transfers` and `withdrawals`.** A
  self-verifying seam, at the cost of two tables and mandate state mirrored
  in three places, to defend against our own code.
- **A `scheduled` transaction type.** Every consumer of `type` would have to
  learn it means "a transfer or a withdrawal".
- **A delayed BullMQ job per schedule.** A lost delayed job silently ends a
  schedule, and edits must find and replace jobs while racing them firing.
- **A sweep every 5–15 minutes.** Each tick releases everything due since the
  last one, so a wider interval bunches the spread runs back together; empty
  ticks cost one index probe.
- **User-chosen time of day.** Re-creates the payday spike and needs
  "time already passed today" rules nothing here needs.
- **A fixed frequency list.** `interval_unit` + `interval_count` is the same
  two columns and the same function, and also covers daily, every N days,
  quarterly and yearly.
- **Retrying across days, or catching up missed runs late.** Moves money days
  after the user expected it, possibly after they paid by hand.
- **Marking bank runs `succeeded` on acceptance.** Claims more than is known
  while the payout is still pending in `withdrawals`.
- **An editable payee.** Lets one schedule flip between P2P and bank rules and
  muddies its run history.
- **Telling recipients about schedules.** Sets an expectation the sender can
  withdraw at any time and exposes the sender's plans. Recorded as future work
  for esusu.

## Consequences

- `scheduling` owns four tables and two BullMQ queues (the sweep and run
  execution) plus a daily upcoming-check job and an event subscription queue.
- `transfers` and `withdrawals` each gain one PIN-skipping method. Any module
  that may import those services could technically call it; boundary lint
  works per module, so review is the guard.
- The run's reference format couples `scheduling` and the
  `withdrawal_completed`/`withdrawal_failed` handler through the `sched_`
  prefix. Those events must carry the withdrawal reference.
- A lost `withdrawal_completed`/`withdrawal_failed` leaves a run `settling`
  until something re-delivers it; with no outbox there is no repair-on-read
  here, because the withdrawal's state lives in `transactions`. A periodic
  check of old `settling` runs against `LedgerService` is the fix if it shows
  up.
- Claims are unbatched: a very large number of runs due in one tick is one
  long transaction. Batching is the first change if that becomes real.
- Many schedules paying one recipient serialise on that wallet's row lock.
  Correct, and cheap at today's scale.
- Future work: scheduled payment of money requests, an incoming-schedules
  view for recipients (esusu), batched claims, and dropping the reserved
  `scheduled`/`bill_split` type values.
