# ADR-0034: Account-takeover controls: security cooldown, user limits, bank-account cooling, self-lock, recipient name and warnings

**Status:** accepted
**Date:** 2026-11-09

## Context

Account takeover is the most likely real loss for a Nigerian wallet: SIM swap,
phished credentials and social engineering, then the balance is moved out
within minutes. The controls so far are the PIN (ADR-0009), step-up MFA for
security changes and for saving a bank account (ADR-0006), and session
reuse detection (§3.7). Saving a bank account raises no alert.

The CBN instant-payment circular (12 March 2026) caps outflows at ₦20,000 for
24 hours after an app is activated on a device (inflows too for new accounts),
lets customers set their own limits with changes taking effect after MFA, and
requires real-time restriction of suspicious transactions. The CBN APP-fraud
draft weighs whether an institution had "warning, or verification protocols"
when apportioning a loss.

## Decision

### Security cooldown

Triggers: trusting a new device, a password reset or change, an email or phone
change, adding or removing an MFA method, a PIN reset. Each sets
`User.securityCooldownUntil = max(current, now + 24h)` in the same transaction
as the change, through a `users` method, and writes an audit event.

While a cooldown is active, P2P sends plus withdrawals over the **rolling last
24 hours** may not exceed ₦20,000. A rolling sum, not a counter reset per
trigger, so re-triggering can only extend the window. It is checked in `kyc`'s
limit check under the existing advisory lock; the effective allowance is the
minimum of tier limit, user limit and cooldown cap. Error
`SECURITY_COOLDOWN_LIMIT` with `cooldownEndsAt` and the remaining allowance;
`GET /wallet/limits` shows it.

New accounts: inflows are also capped at ₦20,000 for 24h from first reaching
Tier 1, enforced in `checkCanReceive` and the funding cap check.

Schedules created before the cooldown started are exempt (a standing mandate
from before any takeover); schedules created during it count, and a run that
would exceed the cap fails as transient.

### User-set limits

An optional `dailyOutflowLimit` per user, held by `kyc`, at most the tier
limit, over the same measure as the tier's daily limit. Lowering is immediate
with the PIN. Raising needs step-up MFA and the PIN and takes effect 24 hours
later, with an immediate security alert carrying the self-lock link; a pending
increase can be cancelled with the PIN. Scheduled runs are not exempt.
`GET /wallet/limits` shows the user limit and any pending increase.

### Bank accounts

Saving a bank account sends a `security_alert` (email, push, in-app) naming
the bank, the masked number and the holder's name, with the self-lock link,
and writes an audit event.

The name Kora returns is compared with the user's KYC legal name (from `kyc`):
normalised for case, punctuation and order, it matches when the surname and at
least one other name appear on both sides. A match sets
`fullyEligibleAt = createdAt`; a mismatch sets `createdAt + 24h`, and until
then withdrawals to that account are capped at ₦20,000 in total
(`BANK_ACCOUNT_COOLING`, with `eligibleAt`). The check is in
`processWithdrawal`, covering live and scheduled withdrawals; a scheduled run
blocked by it is transient. Saving a bank account does not start the account
cooldown.

### Self-lock

Every security alert carries a "This wasn't me" link: a stateless HMAC token
of `userId` and a 7-day expiry, usable only to lock, rate-limited. The app
also has a lock button. Locking, in one transaction under the user's advisory
lock:

1. adds a `self_lock` restriction (ADR-0029); active schedules pause on their
   next run as a frozen sender;
2. revokes every session, trusted device and device key;
3. cancels any pending limit increase;
4. blocks security changes (email, phone, MFA, bank accounts, PIN, limit
   increases) except a password reset by email;
5. audits, and confirms by email and push.

Unlocking needs a password reset completed after the lock, then login (MFA,
device binding, cooldown), then step-up MFA and the PIN. If the email was
changed before the owner locked, a reviewer restores an email the owner
controls after out-of-band verification (`/internal/risk/users/:id/
recover-email`); there is no self-service path.

### Recipient name and warnings

Recipient lookup returns `verifiedName`, the KYC legal name, alongside the
user-chosen names. It appears only in the payment flow, never on social
surfaces. The lookup's per-user rate limit is tightened against harvesting
names.

`sendMoney` and paying a money request return
`422 RISK_ACKNOWLEDGEMENT_REQUIRED` with warning codes when:

- it is the first payment to this recipient and ≥₦20,000;
- the recipient's account is under 7 days old;
- the recipient has an enforced open flag (code `RECIPIENT_UNUSUAL_ACTIVITY`,
  never "reported").

The client shows the warning and resends with `riskAcknowledged: true`; the
acknowledgement is stored on the transaction. Creating a schedule goes through
the same check; its runs do not.

### Decisions made building the cooldown, user limits and bank cooling

- **The cooldown start is stored.** `User.securityCooldownStartedAt` is set
  when a trigger finds no active cooldown and left alone when one extends an
  active cooldown. A schedule is exempt only if it was created before that
  start; deriving the start from `securityCooldownUntil - 24h` would let a
  later trigger move it past a schedule made during the cooldown.
- **The new-account cap is a cumulative inflow cap.** For 24 hours from
  `User.tier1ReachedAt`, the total received by the wallet may not exceed the
  cooldown amount, whatever the balance is. Received means credited fundings
  (net amount) and P2P transfers received, money-request payments included;
  reversals, refunds, chargebacks and releases of held fundings are the
  user's own money returning and do not count. It is checked under the user's
  lock wherever the balance cap is: funding initiation (fundings in flight
  count as projected inflow), funding completion (over the cap the funding is
  held in suspense and refunded, as for a balance-cap breach), an incoming
  transfer (the sender gets the generic recipient-can't-receive answer), and
  money-request and schedule creation. The user's own errors carry
  `NEW_ACCOUNT_INFLOW_LIMIT` with `remaining` and `windowEndsAt`, and
  `GET /wallet/limits` shows the allowance while the window is open.
- **The cooldown amount is one setting** (`SECURITY_COOLDOWN_LIMIT`), used for
  the outflow cap and the new-account inflow cap; the bank-account cooling total is
  `BANK_ACCOUNT_COOLING_LIMIT`. Durations stay 24 hours in code.
- **User limits.** `kyc` owns `user_limits`; a raise is stored as pending and
  read as effective once `pending_effective_at` has passed, so nothing needs a
  job to apply it. A user limit breach reports `DAILY_LIMIT_EXCEEDED` with the
  user's own limit, which scheduling already treats as transient. Lowering
  also clears a pending raise.
- **The limit endpoints live in `payments`** (`/wallet/limits/daily/...`):
  `kyc` may import only `users`, and the flows need the PIN and step-up from
  `auth`. `kyc` exposes lower, request-raise and cancel on `KycService`;
  `payments` verifies, calls it and sends the alert. Only raising needs a
  device signature (`limit.raise`); lowering and cancelling can only make the
  account safer.
- **Surname.** The legal name is stored first, middle, last, so the matcher
  takes its last word as the surname. A holder name matches when it has that
  surname and at least one other word of the legal name; initials do not
  count, and the last word of the holder name may be a truncated prefix of at
  least three letters.
- **Bank cooling cap** is the total of pending and completed withdrawals to
  that saved account, read under the user's lock from the withdrawal's stored
  bank account snapshot.
- **Scheduling.** `security_cooldown_limit` and `bank_account_cooling` are new
  failure codes. Neither is permanent, so a run is retried within the Lagos
  day like `daily_limit_exceeded`; clients see them as they are.

## Alternatives considered

- **A counter reset by each security event.** An attacker resets it by
  changing the email.
- **Exempting nothing from the cooldown.** Changing a password would bounce
  that day's rent.
- **A flat 24–48h block on every new bank account.** Most accounts saved are
  the user's own; name-matching spares them.
- **Making raised limits instant after MFA.** An attacker with MFA raises and
  drains in one sitting.
- **A stored token table for lock links.** Locking twice is harmless, so a
  signed token is enough.
- **Self-service email recovery from a locked account.** That flow is itself
  an account-takeover path.
- **A separate quote/preview endpoint for warnings.** One more round trip on
  every send; the 422-and-resend only costs it when a warning applies.

## Consequences

- `users` gains `securityCooldownUntil`; `kyc` gains user limits and a third
  term in the effective-limit calculation; `BankAccount` gains
  `fullyEligibleAt`.
- New error codes: `SECURITY_COOLDOWN_LIMIT`, `BANK_ACCOUNT_COOLING`,
  `RISK_ACKNOWLEDGEMENT_REQUIRED`.
- New or extended notifications: bank account saved, limit increase pending,
  account locked, device signed out.
- The CBN's ₦20,000 figure is configuration, reconfirmed before launch.
