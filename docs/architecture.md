# Cliqpay — Project Documentation (v10)

> Cliqpay is a production-grade peer-to-peer payment platform. A Venmo-equivalent for Africa — built on NestJS, PostgreSQL, TypeORM, currently integrated with Kora.

> **v10 changes:** Phase 4 design pass — a new `withdrawals` module owning `bank_accounts` and payout orchestration, since neither `payments` (owns no tables) nor `ledger` (zero peer-dependency) nor `transfers` (user-to-user only, per ADR-0011) can take it (ADR-0014); bank-account save requires provider-resolved account names and step-up MFA; debit-first posting with a single compensating-transaction failure path covering both synchronous provider rejection and async webhook failure; withdrawal bounds and PIN/idempotency rules mirror Phase 3's transfer pattern; platform fee launches at ₦0 but — unlike transfers — all 5 ledger legs always post regardless, since `provider_fee` is real settled money. Also: `bank_accounts` (§5).

> **v9 changes:** Phase 3 design pass — the transaction PIN's format, storage and lockout (ADR-0009); idempotency scoped to the sender and matched by request fingerprint, fixing two defects in the shipped funding flow (ADR-0010); a `transfers` module so `ledger` keeps its zero peer-dependency property (ADR-0011); the money-request state machine, with expiry derived rather than swept (ADR-0012); in-app notifications as a persisted fourth channel, plus per-channel dispatch fixing a live cross-channel retry bug (ADR-0013). Also: the zero-fee posting shape and the `fee_income` contention it hides (§4.2), `money_requests` / `notifications` / the new `credentials` columns (§5), concurrency criteria made gating rather than follow-up (§6 Phase 3), and two follow-on items recorded against Phase 7. *(The v8 tags already in the body are Phase 2's audit hardening — webhook amount cross-checking, the production guard on `fake` adapters, and the DB-level append-only trigger on `ledger_entries` — which landed without a header entry.)*

> **v7 changes:** pre-development gap check — secrets/key management, a migration-discipline rule for the ledger, database backups with PITR, error tracking, OpenAPI docs, and an explicit CI cadence for the four test layers (§7, §10); a data-protection nuance separate from financial licensing (§6); and an explicit design-vs-build-order note before the phased plan, since the real risk at this point is never finishing a first slice, not under-designing. **This document should now live in the repo (**`docs/architecture.md`**), versioned with code changes, rather than continuing to evolve only here.** (v6 — modular monolith + TDD strategy; v5 — deferred fraud prevention, frontend/client notes; v4 — full auth/MFA design; v3.1 — provider-agnostic design; v2 — architecture review fixes — all remain in place.)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Core Concepts](#3-core-concepts)
4. [Financial Architecture](#4-financial-architecture)
  - [Account Model](#41-account-model)
  - [Transaction Types](#42-transaction-types)
  - [The Invariant](#43-the-invariant)
  - [External Reconciliation](#44-external-reconciliation)
5. [Database Schema](#5-database-schema)
6. [Phased Development Plan](#6-phased-development-plan)
7. [Production Considerations](#7-production-considerations)
8. [Feature Reference](#8-feature-reference)
9. [Frontend & Client Considerations](#9-frontend--client-considerations)
10. [Code Architecture & Testing Strategy](#10-code-architecture--testing-strategy)

---

## 1. Project Overview

Cliqpay is a production-grade virtual wallet and peer-to-peer payment platform built for real users across Africa. Users can fund their wallets, send and receive money from other Cliqpay users, split bills, withdraw to their bank accounts, and interact with a social transaction feed — all in a secure, reliable, and scalable system.

**Payment Provider:** [Kora](https://korahq.com/) — chosen for multi-country support without per-country verification requirements, and built-in KYC/KYB verification APIs. **[v3]** The system is architected to be provider-agnostic at the data layer — Kora is the only *active* provider, not a structural assumption baked into the schema.

**Target Market:** Nigeria first, with multi-currency and multi-country support built into the architecture from the start.

**Production Standards This System Is Held To:**

- Financial correctness — double-entry ledger, no money created or destroyed
- Reliability — idempotent operations, atomic transactions, graceful failure handling
- Security — JWT with refresh rotation, webhook signature verification, KYC-gated limits
- Auditability — full ledger trail, reconcilable at any point in time
- **[v2]** External correctness — internal ledger balance verified against the provider's actual reported balance, not just self-consistency
- Scalability — architecture that supports growth without fundamental redesign, **[v3] including swapping or adding payment providers**

---

## 2. Tech Stack


| Layer            | Choice                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| Framework        | NestJS                                                                          |
| Database         | PostgreSQL                                                                      |
| ORM              | TypeORM                                                                         |
| Payment Provider | Kora (active) — **[v3]** abstracted behind a `PaymentProviderAdapter` interface |
| Job Queues       | BullMQ                                                                          |
| Auth             | Custom JWT (access + refresh tokens)                                            |
| Language         | TypeScript                                                                      |
| Caching          | Redis                                                                           |
| Email            | Brevo (transactional)                                                           |
| Logging          | Pino                                                                            |
| Monitoring       | Pino structured logs (deferred)                                                 |
| Deployment       | AWS EC2 (deferred)                                                              |


**[v2] Money representation:** all monetary amounts are stored and computed as **integer minor units** (kobo for NGN, cents for USD, etc.) — `bigint` columns, never `decimal` or floating point. Every currency has a known minor-unit exponent (NGN: 2, USD: 2). This eliminates an entire class of rounding/precision bugs at the source. Application-layer arithmetic on money should go through a single small `Money` helper (integer math only) rather than being scattered across services.

---

## 3. Core Concepts

### 3.1 Double-Entry Ledger

Cliqpay models money using **double-entry bookkeeping** — the same system used by real financial institutions. The core rule:

> Every transaction affects at least two accounts, and the total must always balance to zero.

Money never appears or disappears. It always moves *from* one account *to* another. Every movement is recorded on both sides.

### 3.2 Account Types

Accounts have types that determine how they behave:


| Type          | Normal Balance | Description                                | Example           |
| ------------- | -------------- | ------------------------------------------ | ----------------- |
| **Asset**     | Debit          | Money you own or that is held for you      | `float_ngn`       |
| **Liability** | Credit         | Money you owe to others                    | `user_wallet`     |
| **Equity**    | Credit         | Accumulated earnings (revenue)             | `fee_income_ngn`  |
| **Expense**   | Debit          | **[v2]** Costs incurred and passed through | `fee_expense_ngn` |


The fundamental equation that must always hold:

```
Assets = Liabilities + (Equity − Expenses)

```

**[v2] Why Expense exists:** the provider's fee is fully passed through to the user (they receive net, or are debited gross) — it's never actually Cliqpay's cost. But burying it in JSON metadata means "how much have we routed to the provider in fees this quarter" requires scanning every transaction's metadata instead of summing a column. `fee_expense` (debit-normal) makes that number a plain `SUM()`. It's always paired with a same-amount credit to `fee_recovery` (an Equity-type account, since the cost is fully recovered from the user) — see §4.2. The pair nets to zero on Cliqpay's books by design; it exists purely for reporting granularity, not because Cliqpay bears the cost.

### 3.3 Cached Balance

Computing balance by summing ledger entries on every read is expensive. `accounts.balance` is a cached column, **but it is not an independent source of truth** — it must always equal the `running_balance` of that account's most recent `ledger_entries` row. There should be exactly one place in code that writes both numbers, in the same DB transaction, from the same computation. If they can ever diverge, you have two ledgers instead of one — don't let the cache column drift into being a second bookkeeping system.

### 3.4 Idempotency

Payment operations must never execute twice. Every transaction carries a unique **idempotency key** (the `reference` column).

- **Provider-initiated** operations (webhooks) are deduped against the provider's own reference before processing — duplicate events are silently ignored.
- **[v2] Client-initiated** operations (a P2P send, a withdrawal request) need the *same* protection from a different failure mode: a double-tap or a client retry after a timeout. The client must generate and send a request-scoped idempotency key; the API rejects a second request carrying a key it's already seen, returning the original result instead of creating a second transaction.

### 3.5 Atomicity

Every money movement that touches multiple accounts must succeed or fail as a unit. If any part fails, everything rolls back. No partial state is ever persisted.

**[v2] Lock ordering:** any operation that locks more than one wallet row (e.g. a P2P transfer locking sender + recipient) must acquire those locks in a single global order — by `account_id` ascending, regardless of transfer direction. Without this, two concurrent transfers between the same pair of accounts in opposite directions will deadlock under load. Lock rows first, *then* check balance, *then* write the debit — never check-then-lock (that's a TOCTOU race that lets a balance check pass and then get invalidated before the debit lands).

### 3.6 Provider Abstraction — **[v3, new]**

Cliqpay is built against one active provider (Kora), but nothing about *which* provider it is should be hardcoded into account names, schema, or ledger logic. Two things make this real:

- **Database layer (this document):** every account or transaction that touches a specific provider carries a `provider` column (`varchar`, constrained by a `CHECK` clause) instead of the provider's name being baked into an identifier (no more `kora_float_ngn` — just `float_ngn` scoped by `provider = 'kora'`). Adding a new provider means widening the `CHECK` constraint plus creating new system accounts, not a migration of existing data.
- **Application layer (not this document, but don't skip it):** a `PaymentProviderAdapter` interface — `initiatePayment()`, `verifyWebhookSignature()`, `initiatePayout()`, `verifyKyc()` — implemented per provider (`KoraAdapter` today, `PaystackAdapter` later). Webhook signature schemes, payout API shapes, and KYC call formats are fundamentally different between providers; no schema design removes that work. **The DB change below removes the data-migration blocker to switching — it does not remove the integration work.** Both are needed; only one is in scope here.

Since only Kora is active right now, none of this changes day-one behavior — it changes what "add Paystack in six months" costs later.

### 3.7 Session Security — **[v4, new]**

Auth was originally scoped as "JWT + refresh, bcrypt, rate limiting" — that's the minimum, not a full design for an app moving real money. Two principles now apply:

- **Sessions must be revocable, and reuse must be detected.** **[v7.1]** One `sessions` row per login (not a row per issued refresh token) — a stolen phone can have its session killed on demand. Each session stores `currentTokenHash` and `previousTokenHash` (SHA-256, not bcrypt — a refresh token is a high-entropy random value, not a human secret, so nothing is gained from deliberate slowness, and a fast hash keeps the lookup indexable); rotation updates both in place. Presenting a token that matches `previousTokenHash` — an already-superseded token being replayed — is a theft signal and revokes the session immediately; presenting one that matches neither is just an invalid token, no session-wide action. Logout uses the same `status = revoked` mechanism, row kept, not deleted, rather than a separate delete path. This is a one-generation reuse-detection window, not unbounded lineage, traded deliberately for a table that doesn't grow one row per rotation forever.
  - **[v7.2, deferred]** Rotation has no row lock or conditional-update guard: two concurrent `refresh()` calls presenting the *same* token both read the row, and whichever `save()` lands second silently wins — the other caller's just-issued token is immediately unusable. Not built as of issue #3 because the obvious fix (a pessimistic lock/transaction serializing the two calls) trades a silent, low-impact failure (one caller re-logs in) for a worse one: the second call, once serialized behind the first, sees its token now matching `previousTokenHash` and gets treated as theft — revoking the whole session and firing the security_alert email over what was really just a dropped-connection retry or double-tap, not an attack. The real fix is a short grace window (a `previousTokenHash` match within a few seconds of that rotation's own timestamp is a benign concurrent retry, reissued rather than revoked; a match well outside that window still revokes) — a genuine change to the reuse-detection rule above, not a one-line lock, so it's deferred rather than bolted on. Revisit if it's ever observed in practice (client retry logic that fires a duplicate `refresh()`, or load testing that surfaces it), not preemptively.
- **Logging in and moving money are different trust levels.** A valid session proves who you are; it should not by itself be sufficient to move money. A separate transaction PIN (distinct from the login password) is required before P2P sends, withdrawals, or bank account changes — so a hijacked session alone can't drain a wallet. MFA (email, SMS, authenticator app, or a security key — a user may enroll more than one) is required for login on new devices and for high-risk actions (large withdrawal, adding a bank account, changing password or email), not necessarily every login on a trusted device.

Password reset and email verification (wallet unusable until the email is verified) round this out — unglamorous, but skipping them is how "JWT + refresh" quietly becomes the whole security model instead of one piece of it.

### 3.8 MFA Mechanics — **[v4, new]**

MFA is a **challenge/verify** cycle (`mfa_challenges`), not a single check: a challenge is created against one enrolled method (email/SMS code, TOTP, or a WebAuthn assertion for a security key), and a separate call verifies it before tokens are issued. It only fires when needed — a **device-trust window** (`trusted_devices`, ~30 days) lets a recognized device skip MFA on ordinary login, while **step-up challenges** fire unconditionally regardless of device trust for changing security-relevant settings (password, email, MFA methods, bank accounts) or withdrawals above a threshold — being logged in on a trusted device doesn't grant permission to change the account's own security surface without re-proving it's the account owner.

**[v7.1, deferred]** `mfa_recovery_codes` — not being built for now. The original reasoning (losing a phone with TOTP + SMS both gone is a permanent lockout) doesn't apply once email MFA is made a permanent, non-removable baseline method every account always has: "locked out of every enrolled method" then collapses to "lost the email account," which already breaks login and password reset independently of MFA — there's no reachable state recovery codes would rescue. Revisit only if email MFA's permanence is ever relaxed.

**The four methods are not equivalent security, and the design shouldn't imply they are:** security key (phishing-resistant) > TOTP > email > SMS (weakest — SIM-swap is a real, documented attack vector, not a theoretical one). All four are offered for accessibility, but TOTP/security-key should be nudged as primary in the UI rather than presented as interchangeable. SMS challenge dispatch also needs its own per-user rate limit, separate from login rate limiting, or it becomes a free vector for cost abuse or harassment.

---

## 4. Financial Architecture

### 4.1 Account Model

**System Accounts** — created once per (provider, currency) or per currency, depending on whether the account is provider-specific:


| Account role   | Provider-scoped?       | Type    | Purpose                                                                                    |
| -------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `float`        | **Yes**                | Asset   | Real money a specific provider holds on Cliqpay's behalf                                   |
| `fee_expense`  | **Yes**                | Expense | **[v2]** That provider's own fee, gross, before recovery                                   |
| `fee_recovery` | **Yes**                | Equity  | **[v2]** Offsetting recovery — always equals fee_expense above                             |
| `fee_income`   | No — per currency only | Equity  | Cliqpay's own platform fee revenue, regardless of which provider processed the transaction |


**[v3] Why the split:** `float`, `fee_expense`, and `fee_recovery` are provider-scoped because they represent something specific to *that* provider — real cash sitting there, and that provider's own fee structure. `fee_income` is Cliqpay's own margin and doesn't change based on which rail moved the money, so it stays per-currency only. Example for NGN with Kora as the only active provider: `float_ngn` (provider: `'kora'`), `fee_expense_ngn` (provider: `'kora'`), `fee_recovery_ngn` (provider: `'kora'`), `fee_income_ngn` (provider: `null`). If Paystack were added later for NGN, it would get its own `float_ngn` / `fee_expense_ngn` / `fee_recovery_ngn` rows (same role, same currency, different `provider` value) — `fee_income_ngn` stays a single shared account.

**User Accounts** — one wallet per user per currency they hold, never provider-scoped:


| Account       | Type      | Purpose                                   |
| ------------- | --------- | ----------------------------------------- |
| `user_wallet` | Liability | What Cliqpay owes each user, per currency |


> A user wallet is a **liability** because the balance belongs to the user, not Cliqpay. Cliqpay is merely holding it. A user's NGN wallet doesn't care whether it was funded via Kora or Paystack — one wallet, whichever providers touched it over time.

---

### 4.2 Transaction Types

**Fee Policy:**

- The provider's fee is passed directly to the user, but is now also recognized on the ledger via the expense/recovery pair (see §3.2)
- Cliqpay platform fees are charged separately per transaction type
- Platform profit accumulates in `fee_income_<ccy>`

---

#### Funding

*User deposits money into their Cliqpay wallet via the active provider.*

```
DEBIT  float_ngn         net_amount
CREDIT user_wallet       net_amount
DEBIT  fee_expense_ngn   provider_fee
CREDIT fee_recovery_ngn  provider_fee

metadata: { gross_amount }
transaction.provider: 'kora'
transaction.provider_reference: <Kora's own reference for this payment>

```

**Balance effect:** `float_ngn` ↑ by net_amount · `user_wallet` ↑ by net_amount · expense/recovery pair nets to zero.

**Equation check:** Debits = net_amount + provider_fee = gross_amount. Credits = net_amount + provider_fee = gross_amount. ✓

---

#### P2P Transfer

*User sends money to another Cliqpay user. Cliqpay charges a platform fee. No provider involved — money never leaves Cliqpay's system.*

```
DEBIT  sender_wallet     amount + platform_fee
CREDIT recipient_wallet  amount
CREDIT fee_income_ngn    platform_fee

metadata: { note, is_public }
transaction.provider: null   -- purely internal, no provider touches this

```

Unchanged from v1/v2 — this one was already correct, and stays provider-free by nature.

**[v9] Zero platform fee.** The fee is flat, config-driven, and launches at ₦0. When it is zero the `fee_income` leg is **not** posted — a zero-fee transfer is a balanced two-leg posting (sender debit, recipient credit), not a three-leg one with a zero-amount row. `ledger_entries` is the table guaranteed to grow without bound, and a permanent zero-information row on every transfer is both storage and a misleading statement line. The fee is still reported as `0` in API responses so a client can render "Free" — an absent ledger row is not an absent reported fee.

**[v9] Contention, stated so it isn't discovered.** At a non-zero fee, every transfer in the system locks the single `fee_income_<ccy>` row, so all transfers serialize globally. This is accepted rather than engineered around: a single-row update inside a short transaction is something Postgres handles at thousands per second, and the real hazard is a long transaction *holding* the lock — which the existing rule against provider calls and event publishing inside a DB transaction already addresses. Sharding `fee_income` would break the `(role, currency)` uniqueness §5 enforces and turn the §4.3 invariant into a sum across shards. What matters is that the ₦0 launch **hides** this: the lock set is conditional on fee > 0, so transfers run fully concurrently today and drop to serial the day the fee changes.

---

#### Withdrawal

*User withdraws money to their bank account. Both the provider and Cliqpay charge fees, fully borne by the user.*

```
DEBIT  user_wallet       amount + platform_fee + provider_fee
CREDIT float_ngn         amount + provider_fee
CREDIT fee_income_ngn    platform_fee
DEBIT  fee_expense_ngn   provider_fee
CREDIT fee_recovery_ngn  provider_fee

metadata: { bank_account, net_amount }
transaction.provider: 'kora'
transaction.provider_reference: <Kora's payout reference>

```

**Balance effect:** `user_wallet` ↓ full amount · `float_ngn` ↓ by amount+provider_fee (real cash: `amount` to the bank, `provider_fee` to the provider) · `fee_income_ngn` ↑ · expense/recovery pair nets to zero.

**Equation check:** Debits = (amount+platform_fee+provider_fee) + provider_fee. Credits = (amount+provider_fee) + platform_fee + provider_fee. Both equal amount+platform_fee+2·provider_fee. ✓

---

#### Chargeback / Reversal — **[v2, new]**

*A bank reverses a previously-completed funding transaction, after the user may have already spent part or all of it.*

This is always a **compensating transaction**, never a mutation of the original entries (ledger entries are append-only — see §7). It has its own row in `transactions`, with `type = chargeback`, `reverses_transaction_id` pointing at the original funding transaction, and the same `provider` value as the original.

```
DEBIT  user_wallet  original_net_amount
CREDIT float_ngn    original_net_amount

metadata: { dispute_reference }

```

If the user has already spent some of the funded amount, `user_wallet` legitimately goes **negative** — that negative balance is the user's real debt to Cliqpay, and should be surfaced explicitly (see Phase 5) rather than treated as an error state.

---

#### Profit Withdrawal

*Cliqpay moves accumulated platform earnings out for operations.* Unchanged from v1/v2, aside from the account rename.

```
DEBIT  fee_income_ngn  amount
CREDIT float_ngn       amount

```

`float_ngn` here resolves to whichever provider currently holds the float (Kora today) — Cliqpay's own equity account doesn't need to know or care which provider that is.

---

### 4.3 The Invariant

At any point in time, per currency, this must hold across **all active providers for that currency**:

```
Σ over active providers p: float_<ccy>[p] = Σ(user wallet balances in <ccy>) + fee_income_<ccy>

```

With Kora as the only active provider, this collapses to exactly the v2 equation (`float_ngn[kora] = Σ(user wallets) + fee_income_ngn`) — the generalization only starts to matter the day a second provider is added, and it costs nothing to write it this way now.

**[v2] Note:** `fee_expense` and `fee_recovery` don't appear in this equation — they always move together in equal amounts, so they cancel out and never affect the invariant. They exist purely for fee reporting, not for reconciliation math.

**[v2] Important limitation:** this equation is guaranteed to hold by construction — every transaction posts balanced debits and credits, so internal self-consistency can't actually break unless someone bypasses the ledger layer. It tells you your books agree with themselves. It does **not** tell you your books agree with reality — see §4.4.

### 4.4 External Reconciliation — **[v2, updated]**

The check that actually catches real production failures — a dropped webhook, a duplicate payout, a chargeback the provider processed that never reached Cliqpay, a bug on the provider's side — is comparing the **internal ledger balance** of each provider's `float_<ccy>` account against **that provider's own reported balance**, via their balance/settlement API. **[v3]** This check is naturally per-provider, which is exactly what the `provider` column scoping was built for — each provider's float is reconciled against that same provider's API, independently.

- Scheduled job (BullMQ), runs on an interval (start with hourly, tighten later)
- For each (provider, currency) pair: fetch that provider's reported balance, compare to `float_<ccy>[provider]`'s ledger balance
- Mismatch → alert immediately, do not auto-correct — a human investigates before anything is adjusted
- Every run's result (provider, currency, match/mismatch, both values, timestamp) is logged and queryable

This is a first-class production requirement, not a nice-to-have — it belongs in Phase 2, as soon as real money starts moving.

---

## 5. Database Schema

```
accounts
  id                uuid PK
  type              enum (asset | liability | equity | expense)
  role              enum (float | fee_income | fee_expense | fee_recovery | fx_clearing | fx_spread_income | user_wallet)
  provider          varchar nullable   -- CHECK (provider IN ('kora')) — set for float / fee_expense / fee_recovery; null for fee_income, fx_*, user_wallet
  user_id           uuid FK nullable   -- null for system accounts
  currency          varchar            -- ISO 4217, e.g. 'NGN', 'USD'
  balance           bigint default 0   -- cached (minor units), derived from ledger_entries.running_balance
  created_at        timestamp

transactions
  id                    uuid PK
  reference             varchar unique     -- Cliqpay's own idempotency key (client-supplied for client-initiated ops)
  provider              varchar nullable   -- CHECK (provider IN ('kora')) — which provider processed this; null for purely internal transactions (p2p, profit withdrawal)
  provider_reference     varchar nullable  -- the provider's own reference for this operation; indexed, used to correlate webhooks
  type                  enum (funding | p2p_transfer | withdrawal | chargeback | profit_withdrawal | bill_split | scheduled)
  status                enum (pending | completed | failed | reversed | disputed)
  reverses_transaction_id uuid FK nullable  -- set on chargeback/reversal rows
  amount                bigint             -- minor units
  currency              varchar
  sender_wallet_id      uuid FK nullable
  recipient_wallet_id   uuid FK nullable   -- denormalized convenience only; see note below
  metadata              jsonb              -- provider-specific extra fields (raw webhook payload, etc.) — this is where per-provider shape differences are absorbed
  created_at            timestamp
  updated_at            timestamp

ledger_entries
  id                uuid PK
  transaction_id    uuid FK
  account_id        uuid FK
  direction         enum (debit | credit)
  amount            bigint              -- minor units
  running_balance   bigint              -- balance of this account after this entry
  created_at        timestamp

-- [v9] Phase 3 — owned by `transfers` (see ADR-0011)
money_requests
  id                uuid PK
  requester_user_id uuid                -- cross-module reference, no FK
  payer_user_id     uuid                -- cross-module reference, no FK
  amount            bigint              -- minor units
  currency          varchar
  note              varchar nullable
  status            enum (pending | paid | declined | cancelled)
  expires_at        timestamptz         -- 'expired' is derived from this, never stored
  transaction_id    uuid FK nullable    -- set when paid; the transfer this produced
  created_at        timestamptz
  updated_at        timestamptz

-- [v9] Phase 3 — owned by `notifications` (see ADR-0013)
notifications
  id                uuid PK
  user_id           uuid                -- cross-module reference, no FK
  type              varchar             -- the notification catalog's type key
  data              jsonb               -- structured payload for deep linking; never secrets
  title             varchar             -- rendered at write time
  body              text                -- rendered at write time
  dedupe_key        varchar             -- unique with (user_id, type)
  read_at           timestamptz nullable
  created_at        timestamptz

-- [v10] Phase 4 — owned by `withdrawals` (see ADR-0014)
bank_accounts
  id                uuid PK
  user_id           uuid                -- cross-module reference, no FK
  provider          varchar             -- same CHECK-constraint pattern as accounts.provider
  bank_code         varchar             -- provider's bank code
  bank_name         varchar             -- provider-returned, human-facing
  account_number    varchar
  account_name      varchar             -- provider-resolved at save time; never client-supplied
  created_at        timestamptz

  -- unique (user_id, provider, bank_code, account_number)

```

> **[v9] Note on** `money_requests.status`**:** there is deliberately no
> `expired` value. Expiry is derived from `expires_at` at read time and
> enforced at pay time inside the posting transaction — so any query
> surfacing requests must apply the `expires_at` predicate. Reading `status`
> alone is wrong. See [ADR-0012](adr/0012-money-requests.md).

> **[v9] Note on** `notifications`**:** rows are deleted after 180 days by a
> scheduled job. This does **not** contradict the append-only rule — that
> rule covers `ledger_entries`, which is financial history under a DB
> trigger. Notifications are a UI convenience, already mutable by design via
> `read_at`, and deleting one destroys nothing.

> **[v9] Note on** `credentials`**:** Phase 3 adds `failed_pin_attempts` and
> `pin_locked_until` alongside the existing `failed_login_attempts` /
> `locked_until`. The two mechanisms have deliberately different thresholds
> (3/15min vs 5/15min) and deliberately different blast radii — a PIN lock
> blocks money movement only, never login. Do not harmonize them; see
> [ADR-0009](adr/0009-transaction-pin.md).

> **[v3.1] Widening the** `CHECK` **constraint** when a new provider is added is a normal `ALTER TABLE ... DROP CONSTRAINT ...; ALTER TABLE ... ADD CONSTRAINT ... CHECK (provider IN ('kora', 'paystack'))` — no join table, no FK, no enum-migration edge cases. The application layer mirrors this with its own `type ProviderCode = 'kora'` union type, so a typo is caught at compile time before it ever reaches the DB constraint.

> **Note on** `accounts`**:** serves both system accounts (`float_ngn`, etc.) and user wallets. `user_id` is null for system accounts. A system account's identity is the tuple `(role, provider, currency)` for provider-scoped roles, or `(role, currency)` for provider-agnostic ones — enforce this with a partial unique index rather than encoding it into a name string.

> **[v2] Note on** `sender_wallet_id` **/** `recipient_wallet_id`**:** these two columns are a denormalized convenience for fast "sent to / received from" queries in transaction history — they are **not** the source of truth for who was involved in a transaction, and don't generalize past two parties. The source of truth for participants is always `ledger_entries` joined to `accounts`. Don't build business logic that assumes exactly two parties from these columns.

> **[v3] Note on** `reference` **vs** `provider_reference`**:** these are two different things and both matter. `reference` is Cliqpay's own idempotency key (ours, generated by us or the client). `provider_reference` is whatever ID the active provider uses internally — needed to correlate an incoming webhook back to the right transaction, and kept as a first-class indexed column rather than inside `metadata`, since webhook lookups are a hot path.

---

## 6. Phased Development Plan

Each phase exits with a working, production-quality slice of the system. No phase begins until the previous one is stable, tested, and meets production standards — proper error handling, input validation, logging, and test coverage.

> **[v7] Design vs. build order:** everything in this document through §10 is a design decision, not a build order. The risk at this stage isn't under-designing — it's never finishing a first working slice because there's always one more thing to design. Build incrementally against the *design already locked in*: e.g. ship Phase 1 with email + TOTP as the only working MFA methods, add SMS and the security key once the rest of the system is running — the schema already supports all four, so this is sequencing, not re-architecture.

---

### Phase 1 — Foundation

**Goal:** Users can register, log in, and have a wallet. No money moves yet.

- NestJS project structure — modules, config, environment
- PostgreSQL + TypeORM setup, migrations
- Database schema implementation — amounts as `bigint` minor units throughout
- **[v3.1]** `CHECK` constraint on `accounts.provider` / `transactions.provider` initially allows only `'kora'`
- **[v2/v3]** Seed system accounts per active currency, scoped by role + provider where applicable (`float_ngn`, `fee_expense_ngn`, `fee_recovery_ngn` with `provider = 'kora'`; `fee_income_ngn` with `provider = null`) — currency list is configurable, only NGN active initially
- Auth — register, login, logout
- **[v4]** JWT access tokens (short-lived) + **[v7.1]** DB-backed `sessions` (one row per login, rotated in place on refresh, revocable, `currentTokenHash`/`previousTokenHash` for replay detection — see §3.7)
- **[v4]** Email verification, built but not yet gating anything in Phase 1 — no Phase 1 endpoint checks it yet
- **[v4, v7.1]** Password reset flow, sharing a purpose-tagged `verification_codes` table with email/phone verification (single-use, expiring) rather than its own dedicated table
- **[v4]** MFA enrollment (`mfa_methods` — email mandatory and non-removable, TOTP optional in Phase 1; SMS/security key deferred per the build-order note below) and the supporting challenge/verify flow (`mfa_challenges`, `trusted_devices` — see §3.8), required for new-device login and high-risk actions
- **[v4]** Separate transaction PIN (`transactionPinHash` on `User`, distinct from login password) required before any money-moving action — added here structurally even though it's not enforced until Phase 3/4
- **[v4]** Account lockout after repeated failed login attempts (`failedLoginAttempts`, `lockedUntil`), rate-limited per-IP **and** per-account
- Password hashing (bcrypt)
- Rate limiting on auth endpoints
- Input validation (class-validator) on all endpoints
- User profile endpoints
- Wallet auto-created on registration (NGN default)
- Balance endpoint
- Global exception filter — consistent error responses
- Request logging

**Key concepts:** NestJS architecture, TypeORM migrations, revocable session design, MFA, currency- and provider-scoped double-entry schema design

---

### Phase 2 — Wallet Funding

**Goal:** A user can fund their wallet. Balance updates. History shows it.

- **[v3]** `PaymentProviderAdapter` interface defined; `KoraAdapter` implements it for payment initialization, webhook verification — this is where provider-specific logic lives, not scattered through services
- Kora payment initialization — generate payment link (via `KoraAdapter`)
- Webhook receiver endpoint
- Kora webhook signature verification (via `KoraAdapter`)
- Idempotency — deduplicate webhook events by `provider_reference`
- Ledger entries for funding transaction, including expense/recovery pair (atomic)
- **[v2]** External reconciliation job — scheduled diff of each provider's `float_<ccy>` against that provider's reported balance, alerting on mismatch
- Transaction history endpoint (paginated)
- Email notification on successful funding

**Key concepts:** Webhooks, idempotency, event-driven money movement, atomic writes, external reconciliation, provider adapter pattern

---

### Phase 3 — P2P Transfers

**Goal:** Two users can move money between each other.

- **[v9]** Transaction PIN lifecycle — set, change, reset (behind step-up MFA), enforced on **every** money-moving request. 4 digits, HMAC-peppered then bcrypt; lockout state separate from login's at 3 attempts / 15 min. See [ADR-0009](adr/0009-transaction-pin.md)
- **[v9]** Recipient lookup — resolve a username or email to a payable recipient, rate-limited, so the sender confirms a name before committing. Transfers take the resolved `userId`, not the raw identifier. Username and email only; not phone
- Send money by username or email
- Request money from another user — see [ADR-0012](adr/0012-money-requests.md): `pending → paid | declined | cancelled | expired`, 7-day expiry derived from `expires_at` rather than swept, exact amount only, max 3 outstanding per requester→payer pair
- **[v2]** Lock ordering — always lock wallet rows by `account_id` ascending, regardless of transfer direction, to prevent deadlocks between concurrent opposite-direction transfers
- Lock rows first, then check balance, then debit (not check-then-lock)
- Atomic ledger entries — sender debit, recipient credit, fee to fee_income
- **[v9]** Platform fee is flat and config-driven, launching at **₦0**. The `fee_income` leg is posted only when the fee is non-zero, so a zero-fee transfer is a two-leg posting; tests must run at a non-zero fee to cover the three-leg path. Note the consequence: at a non-zero fee every transfer locks the single `fee_income_<ccy>` row, serializing all transfers globally — accepted deliberately, see §4.2
- **[v2, v9]** Client-supplied idempotency key required on send/request requests, separate from webhook idempotency — scoped to the sender and matched against a request fingerprint, see [ADR-0010](adr/0010-idempotency-key-scoping.md)
- **[v9]** Eligibility and bounds: sender must have a verified email (the first endpoint to enforce Phase 1's verification), recipient need not; self-transfer rejected; NGN only; minimum ₦100; configurable maximum as an interim ceiling until Phase 6 tier limits replace it
- Transaction history — sent and received correctly distinguished, direction resolved per viewer
- **[v9]** In-app notifications — a persisted fourth channel in the existing `notifications` module, with list/unread-count/mark-read endpoints and 180-day retention. Dispatch becomes one job per channel so a failing channel can no longer cause another's redelivery. See [ADR-0013](adr/0013-in-app-notifications.md)
- Email notification on send and receive
- **[v9]** Orchestration lives in a new `transfers` module, which also owns `money_requests`; `ledger` gains only `postTransfer()` and keeps its zero peer-dependency property. See [ADR-0011](adr/0011-transfers-module-boundary.md)

**Key concepts:** Atomicity, pessimistic locking, deadlock avoidance, race conditions, ledger correctness

> **[v9] Concurrency is the risk in this phase, and it is invisible to ordinary tests.** A P2P implementation with the lock ordering reversed passes every single-threaded test that can be written; the bug appears only under concurrent load, in production, as an intermittent deadlock or a double-spend. Four checks are therefore gating acceptance criteria on the send slice, not follow-up work: (1) A→B and B→A posting simultaneously never deadlock — the first place the ascending-`account_id` rule is actually load-bearing, since funding only ever locks one user wallet; (2) N concurrent transfers from a sender who can afford one commit exactly once, proving lock-then-check rather than check-then-lock; (3) `fast-check` fuzzing of random valid transfer sequences never breaks the §4.3 invariant; (4) every account's cached `balance` equals its latest entry's `running_balance` after every operation. Iteration counts stay modest per-PR and the heavy fuzzing runs on the nightly cadence (§10).

---

### Phase 4 — Withdrawal

**Goal:** A user can withdraw their balance to a bank account.

- **[v10]** A new `withdrawals` module owns `bank_accounts` and withdrawal orchestration (PIN check, idempotency, save/resolve, initiate, webhook, history) — neither `payments` (owns no tables, per ADR-0008) nor `ledger` (would compromise its zero peer-dependency property) can take it, and it is explicitly not folded into `transfers` (per ADR-0011). See [ADR-0014](adr/0014-withdrawals-module-boundary.md)
- **[v10]** Save bank account — client submits `bankCode` + `accountNumber` only; `KoraAdapter.resolveBankAccount()` returns the provider-confirmed `accountName`, which is what gets stored (never a client-supplied name). Resolution failure means nothing is persisted. Requires step-up MFA, same mechanism as email change (ADR-0006) — the cheapest control against account-takeover-then-cashout available before Phase 11's cooling-off window exists
- **[v10]** A user may save multiple bank accounts; no "default" flag — withdrawal requests specify `bankAccountId` explicitly
- **[v10]** Transaction PIN required on every withdrawal initiation, same as every other money-moving request (ADR-0009); client-supplied idempotency key required, scoped to the sender (ADR-0010's pattern, not its funding-webhook dedupe)
- **[v10]** Eligibility and bounds mirror Phase 3's transfer bounds: NGN only, minimum ₦100, configurable maximum as an interim ceiling until Phase 6 tier limits replace it
- **[v10]** Platform fee is flat, config-driven, launching at ₦0 like the transfer fee — but unlike a zero-fee transfer, all 5 ledger legs in §4.2's Withdrawal posting always post regardless of the platform fee's value, since `provider_fee` is real settled money either way and isn't conditionally omittable the way `fee_income` is
- **[v10]** Posting is debit-first: `ledger.postWithdrawal()` posts the full balanced entry set and commits *before* `payments` calls `KoraAdapter.initiatePayout()`. Every failure path — a synchronous provider rejection or an async webhook failure — reverses through the same compensating transaction (§7); there is no separate no-op path for synchronous rejection
- Initiate withdrawal via `KoraAdapter.initiatePayout()`
- Webhook for payout success/failure
- Ledger entries for withdrawal, including expense/recovery pair
- **[v2]** Handle failed payouts via a **compensating transaction** (new transaction + new ledger entries reversing the effect) — never mutate or delete the original entries
- Withdrawal history
- Email notification on withdrawal initiated and completed

**Key concepts:** Payout APIs, failure handling, compensating transactions, reconciliation

---

### Phase 5 — Chargebacks & Disputes — **[v2, new]**

**Goal:** A funded transaction can be clawed back after the fact, even if the user already spent it, without the system silently losing track of the resulting debt.

- Provider chargeback/dispute webhook handling
- Chargeback recorded as a compensating transaction against the original funding (`reverses_transaction_id`)
- Wallet balance may legitimately go negative — this represents real user debt, not an error state
- Flag/freeze account when balance goes negative from a chargeback — block new outbound spend until resolved
- Dispute status tracking (`disputed` → resolved/upheld)
- Basic collections view — list of users with outstanding negative balances and the originating transaction
- Email notification to user on chargeback received and on account restriction

**Key concepts:** Compensating transactions, negative-balance handling, dispute lifecycle

---

### Phase 6 — KYC Tiers

**Goal:** Users have tiers. Limits are enforced per tier.

> **[v4] Regulatory status:** this is a personal project with no live legal exposure. The tier model below is deliberately built to match how CBN's real tiered-KYC framework actually works, and verification is done through **Kora's sandbox environment only** — no real BVN/NIN lookups against NIBSS/NIMC, ever, in this project. If this ever moves toward a real launch, two things need re-confirming before anything else: the exact limits in the *current* CBN circular (they've shifted over time and shouldn't be trusted from this document), and — separately — whether Cliqpay itself needs to hold its own licensing status or can legally operate under Kora's, since that determines whether `user_wallet` is really Cliqpay's liability at all (see §7). **[v7]** Separate from financial licensing: basic data-protection practice (not over-collecting, honoring a delete request, not leaking test data) starts applying the moment any real person's real data touches the system — even a friend testing the app — regardless of whether Cliqpay is a licensed financial entity. "Personal project" changes the licensing calculus, not that one.

- **[v4]** Tier model, corrected to match the real framework — there is no "unverified but functional" tier anymore (BVN/NIN is mandatory even at the lowest tier per CBN's 2024 update):
  - **Tier 0** — registered, email-verified — cannot fund, send, or withdraw yet
  - **Tier 1** — BVN or NIN — modest daily limit and balance cap
  - **Tier 2** — BVN + NIN + address verification — higher daily limit and balance cap
  - **Tier 3** — full KYC + liveness check — highest daily limit, no balance cap
- **[v4]** `KycProvider` interface, mirroring the `PaymentProviderAdapter` pattern (§3.6) — `KoraSandboxKycProvider` (real integration shape, sandbox data) and `FakeKycProvider` (deterministic, no network, for offline/unit tests)
- `tier_limits` seeded with CBN-shaped reference defaults (daily limit + balance cap per tier per currency) — configuration data, not hardcoded, and explicitly labeled as a snapshot to reconfirm against the live circular before any real launch
- Daily/transaction limits enforced per tier per operation type
- **[v2]** Limit checks run inside the same locked transaction as the money movement, against a rolling-window sum — not just at the API layer — to close the race where concurrent requests jointly exceed a limit
- Tier upgrade flow
- Limit exceeded error responses with clear messaging

**Key concepts:** State machines, access control, KYC API integration via adapter pattern, race-safe limit enforcement

---

### Phase 7 — Social Layer

**Goal:** The Venmo-style social feed works. Unchanged from v1.

- Transaction notes and descriptions
- Public/private toggle per transaction
- Follow/unfollow users
- Activity feed — public transactions from followed users (paginated)
- Reactions and comments on transactions
- **[v9]** Soft filter on money requests from non-followed users — they land in a separate bucket and don't push-notify, rather than being blocked outright. Deliberately *not* a hard gate: follow/unfollow is asymmetric and needs no consent, so it isn't a consent signal, and Phase 8 sends payment requests to bill-split participants who often aren't followers. See [ADR-0012](adr/0012-money-requests.md)
- **[v9]** Blocking — an explicit "never let this user request from me again." Deferred from Phase 3, where the per-pair outstanding-request cap bounds the damage in the meantime

**Key concepts:** Social graph, feed architecture, privacy controls

---

### Phase 8 — Bill Splitting

**Goal:** A user can split a bill with multiple people and track payment. Unchanged from v1.

- Create a split request — total amount, participants, description
- System calculates each participant's share
- Each participant receives a payment request
- Track paid/unpaid status per participant
- Initiator notified as each person pays
- Auto-close split when all participants have paid
- Expire uncompleted splits after a configurable window

**Key concepts:** Group state management, distributed transaction logic, event tracking

---

### Phase 9 — Scheduled & Recurring Payments

**Goal:** Payments can be automated. Unchanged from v1.

- Schedule a one-time future payment
- Set up recurring payments — weekly, biweekly, monthly
- BullMQ job processor setup
- Handle failures on scheduled payments — retry logic, notifications
- Cancel or modify scheduled payments
- Audit log of all scheduled payment executions

**Key concepts:** Job queues, background processing, reliability, retry strategies

---

### Phase 10 — Multi-Currency Wallets

**Goal:** Users can hold and transact in multiple currencies. Lighter than originally scoped — the currency-scoped, provider-scoped system accounts and per-currency invariant were already built in Phase 1; this phase is mainly about turning on new currencies and cross-currency transfer.

- User can create additional currency wallets (USD, GHS, KES, etc.)
- Activate new system accounts for a currency (`float_usd`, etc., tied to whichever provider(s) support that currency) via the same boot-seeding logic from Phase 1
- Fund foreign currency wallet via the active provider
- Transfer between same-currency wallets (no change needed — already currency-scoped)
- **[v2] Cross-currency transfer**, worked example:

```
-- NGN side: sender's value leaves the NGN ledger
DEBIT  sender_wallet_ngn      ngn_amount
CREDIT fx_clearing_ngn        ngn_amount

-- USD side: value enters the USD ledger at Cliqpay's rate, spread captured
DEBIT  fx_clearing_usd        usd_amount_at_raw_rate
CREDIT recipient_wallet_usd   usd_amount_after_spread
CREDIT fx_spread_income_usd   spread

```

`fx_clearing_<ccy>` (Asset) is a system account representing value in transit during conversion, and is provider-agnostic like `fee_income` — each currency's ledger balances independently; the clearing accounts are what let value "cross" from one currency's books to another's without breaking either currency's invariant.

- Ledger correctly records currency on all entries (already true from Phase 1)
- Balance per currency on user profile

**Key concepts:** FX clearing accounts, spread capture, currency-aware ledger design

---

### Phase 11 — Security & Fraud Prevention Hardening — **[v5, new, deferred]**

**Goal:** Move from static rules to actual fraud detection. Deliberately last — this needs the rest of the system working and generating real transaction shapes to be worth building against; there's no value in fraud detection over a system with no real usage patterns yet.

- `fraud_flags` table — the review sink every rule below writes to (`open` / `reviewing` / `cleared` / `confirmed`), reviewed by a human, not auto-resolved. A `confirmed` flag sets `User.isFrozen`; an `open` flag holds only the specific transaction it's attached to, not the whole account — a false-positive rule shouldn't lock someone out over one legitimate large transfer
- Bank-account withdrawal cooling-off — `withdrawalEligibleAt` on `BankAccount` (createdAt + 24–48h), checked before payout, so account-takeover-then-immediate-cashout has a window where the real owner can notice and intervene
- Basic velocity rules feeding `fraud_flags`: N transactions in M minutes, large-amount-on-a-new-account, many-senders-then-fast-withdrawal ("mule" pattern) on the recipient side
- Device/IP linkage — reuse the `trusted_devices` fingerprint to detect *how many distinct accounts* share one device, not just whether one account trusts one device
- Webhook replay protection — reject webhooks past a freshness window (e.g. 5 minutes) in addition to signature verification, since a valid signature doesn't prove the request is fresh
- P2P dispute reporting — an endpoint for a sender to report a transaction as a scam, creating a `fraud_flags` row against the *recipient* (P2P has no automatic reversal — the point is to freeze before they withdraw, not to guarantee a refund)
- Explicitly out of scope for this phase: behavioral/ML anomaly detection — needs real transaction volume to be meaningful, and NFIU/SAR-style regulatory reporting integration, which only applies once this is operating under an actual license (see the regulatory-status note in Phase 6)

**Key concepts:** Rules-based fraud detection, human-in-the-loop review workflows, account-vs-transaction-level holds

---

### Not yet phased — candidate future features

Raised during Phase 2 design, deliberately not scoped into any phase above yet — noted here so they aren't forgotten, not so they get built ahead of need:

- **Saved payment methods (card-on-file, recurring charge without redirect).** Checked directly against Kora's documentation (checkout, direct-API, and flexible/pre-auth card flows) — none of them return a reusable token, authorization code, or any other card-on-file identifier; Kora's card flow is single-use only as currently documented. Paystack's charge API is understood to return a reusable `authorization_code` for this purpose, so the likely shape is Kora for regular funding/withdrawal, Paystack as a second, narrowly-scoped provider used only for saved-card charges — the provider-scoped account design (§4.1) already anticipates a second active provider for NGN, so this fits without a schema change. Not yet verified against a real Paystack sandbox the way Kora's shape was confirmed (§3.6) — do that before designing it for real. Also note: "tokenize and charge a saved card" isn't a capability `PaymentProviderAdapter` (§3.6) models at all — it needs its own interface, not a second implementation of the existing one.
- **Card issuing.** Confirmed via Kora's docs — they offer virtual USD Visa/Mastercard issuing (fund a card, let the user spend from it, suspend/terminate, webhooks on card transactions); no physical card product. Unscoped: no phase above accounts for issuing balance, card lifecycle state, or USD as a currency users hold cards in (Phase 10's multi-currency work doesn't currently include USD). Worth its own phase-sizing pass if pursued rather than folding into an existing phase.

---

## 7. Production Considerations

These are non-negotiable standards applied across all phases, not deferred to a "hardening" phase.

### Security

- All endpoints protected by JWT guard except public routes
- Webhook endpoints verify the provider's signature on every request (via the relevant `PaymentProviderAdapter`) — reject anything that fails
- Passwords hashed with bcrypt, never stored or logged in plaintext
- Sensitive fields (bank account numbers, BVN) encrypted at rest
- Rate limiting on auth, payment initiation, and KYC endpoints
- No financial amounts accepted from the client for webhook-confirmed transactions — always derive from the provider's payload. **[v8]** "Derive from the payload" doesn't mean "trust it blindly": the provider-reported amount is cross-checked against what was actually requested at initiation (`transactions.amount`) before posting — a mismatch fails the transaction rather than crediting an unverified figure. Found during Phase 2's audit (H3): nothing enforced this until then, so a manipulated or buggy provider response could otherwise credit an arbitrary amount.
- **[v7]** Encryption keys (for BVN, bank account fields) and provider API credentials live in environment-injected secrets, never committed to the repo — `.env` + `.gitignore` is a reasonable placeholder now; a dedicated secrets manager (AWS Secrets Manager, Doppler, etc.) is worth adopting once there's a real deployment target, not before
- **[v8]** A provider's `fake` adapter (or any `*_PROVIDER=fake` setting) is rejected at boot when `NODE_ENV=production` — `FakeAdapter.verifyWebhookSignature` validates against a key committed to the repo, so a production deploy that fell through to the default would let anyone forge a funding webhook. Found during Phase 2's audit (C1); enforced in `src/config/index.ts`'s `superRefine`.

### Data Integrity

- All money movements wrapped in database transactions — partial writes never committed
- Pessimistic locking on wallet rows during concurrent balance updates, **[v2] always acquired in a consistent global order (**`account_id` **ascending) to prevent deadlocks**
- Idempotency keys on all payment operations — **[v2] client-supplied for client-initiated actions, provider-supplied reference for webhooks** — safe to retry without side effects
- Ledger entries are append-only — never updated or deleted; reversals are compensating transactions, never mutations. **[v8]** DB-enforced, not just application convention: a trigger rejects any `UPDATE`/`DELETE` against `ledger_entries` outright, regardless of which code path issues it — added during Phase 2's audit (L2) after finding this held only because every code path happened to never violate it, not because anything stopped one from doing so.
- **[v7]** This extends to migrations: no migration ever `UPDATE`s or `DELETE`s a row in `ledger_entries` or a historical `transactions` row, including "just this once" bug fixes — a correction is always a new compensating transaction, never a migration touching old data
- **[v7]** Database backups with point-in-time recovery enabled from day one — usually a checkbox on managed Postgres, not custom work, and the one thing that actually protects against losing the ledger outright
- Internal invariant (§4.3) reconciliation runnable on demand and schedulable as a background job
- **[v2] External reconciliation (§4.4), per provider, against each provider's reported balance — the check that actually catches real drift, not just self-consistency**
- All monetary values stored and computed as integer minor units — never floating point, never a shared decimal type without a fixed scale

### Error Handling

- Global exception filter returns consistent error shape across all endpoints
- Payment failures handled explicitly — no silent swallowing of provider errors
- Failed transactions reversed via compensating transaction — no stuck pending states, no mutation of original entries
- All external provider API calls wrapped with timeout and retry logic

### Observability

- Pino for structured JSON logging throughout the application
- Request logging on all endpoints — method, path, status code, duration
- Transaction lifecycle logged at each state change (pending → completed → failed/reversed)
- Webhook events logged before and after processing
- All provider API calls logged with request/response (sensitive fields redacted)
- Reconciliation results (both internal and external, per provider) logged and reviewable
- **[v7]** Error tracking (e.g. Sentry) catches and alerts on unhandled exceptions as they happen — structured logs are for investigating after the fact, not for noticing something broke in real time
- Full monitoring setup deferred — Pino logs serve as the observability layer for now

### API Design

- Consistent response envelope across all endpoints
- Pagination on all list endpoints
- Versioned API routes (`/v1/`)
- Comprehensive input validation with descriptive error messages
- **[v7.2]** OpenAPI docs generated from NestJS/`@nestjs/swagger` decorators (`src/docs/setup-api-docs.ts`), rendered via Scalar at `/reference` (raw spec at `/doc`) instead of the default Swagger UI. A co-located check (`src/docs/__tests__/api-docs-completeness.spec.ts`) walks the module graph and fails if any route handler is missing `@ApiOperation` — the guard against decorators quietly not keeping up as new endpoints are added. Both routes are public in every environment for now — there's no staff/admin auth system yet to gate them behind (see admin auth note below), and building one just for this would be its own feature; revisit if that need becomes real.

---

## 8. Feature Reference


| Feature              | Phase | Core Concept Learned                                                     |
| -------------------- | ----- | ------------------------------------------------------------------------ |
| Auth (JWT + refresh) | 1     | Token security, rotation                                                 |
| Wallet creation      | 1     | Currency- and provider-scoped schema, double-entry foundation            |
| Wallet funding       | 2     | Webhooks, idempotency, external reconciliation, provider adapter pattern |
| P2P transfers        | 3     | Atomicity, deadlock-safe locking                                         |
| Money requests       | 3     | Request/response payment flows                                           |
| Withdrawal           | 4     | Payout APIs, compensating transactions                                   |
| Chargebacks/disputes | 5     | Negative balances, dispute lifecycle                                     |
| KYC tiers + limits   | 6     | State machines, race-safe access control                                 |
| Social feed          | 7     | Feed architecture, social graph                                          |
| Bill splitting       | 8     | Group state, distributed transactions                                    |
| Scheduled payments   | 9     | Job queues, background processing                                        |
| Multi-currency       | 10    | FX clearing accounts, spread modeling                                    |
| Fraud prevention     | 11    | Rules-based detection, human review workflows                            |


---

## 9. Frontend & Client Considerations — **[v5, new — notes only, not this iteration]**

Planned clients: **React Native** for the mobile app, **React/Next.js** for an internal admin panel. Neither is being built yet, but a few backend decisions are cheaper to make now than to retrofit once a client exists:

- **Admin auth should not reuse the customer identity system.** The admin panel touches fraud flags, PII, and account-freeze controls — that calls for a separate `AdminUser` model with a stricter posture than customer auth (e.g. mandatory security-key MFA, no trusted-device skip ever), not a `role` flag bolted onto the existing `User`/session design built for end users.
- **CORS and API surface split.** Next.js admin runs on its own origin — needs an explicit allowlisted origin, and probably its own route namespace (`/v1/admin/`*) with its own guards, rather than sharing endpoints with the consumer-facing API.
- **Push notifications, not just email.** A mobile app implies device push (APNs/FCM) alongside the existing email notifications — needs a `push_tokens` table (userId, platform, token) and a `NotificationChannel` interface, mirroring the `PaymentProviderAdapter`/`KycProvider` adapter pattern already in use, rather than hardcoding Brevo calls everywhere.
- **Token storage is a client-side security decision, but it's the one that can quietly undo all the session-security work already done.** Access/refresh tokens must live in iOS Keychain / Android Keystore-backed secure storage (e.g. `react-native-keychain`), never in plain `AsyncStorage` — a revocable, replay-detecting session design (§3.7) doesn't help if the token itself sits in plaintext on the device.
- **Deep linking for the Kora payment redirect.** Funding currently opens a hosted payment page; on mobile that means a WebView/system browser plus a registered URL scheme to return to the app. Important: the **webhook stays the source of truth**, same as today — the deep link is only what brings the user back into the UI, it never triggers the ledger write itself. **[v8]** The config surface this will eventually point at already exists (`PAYMENT_REDIRECT_URL`, sent to Kora as `redirect_url` on every charge) — it's a placeholder web URL for now since no frontend exists yet; swapping it for a real deep link scheme when mobile is built is a config change, not new plumbing.
- **Client-side idempotency key persistence.** The idempotency key for a client-initiated action (§3.4) needs to be generated and persisted locally *before* the request fires, so the app can safely retry the same key after being backgrounded or losing connectivity mid-request, instead of generating a new key and risking a duplicate.
- **Tier 3 liveness check needs media upload plumbing** that doesn't exist yet — object storage (S3-compatible) plus an upload endpoint for the mobile client to submit the selfie/video Kora's KYC API requires.
- **Real-time balance updates: default to push-notification-triggers-refetch, not WebSockets**, unless a concrete need for live updates emerges — simpler, and consistent with how comparable wallet apps handle it. Worth stating as the default so it isn't left ambiguous and someone builds a WebSocket layer that wasn't actually needed.

---

## 10. Code Architecture & Testing Strategy — **[v6, new]**

Backend, mobile, and admin are **separate repos**, not a monorepo — so tooling here is scoped to the single NestJS backend repo, not cross-repo orchestration (Nx's actual value proposition is monorepo orchestration and cross-app affected-testing; adopting it for one repo would be pulling in a meta-framework to solve a problem that doesn't exist here).

### Modular monolith — one exported service per module, enforced by lint, not convention

```
src/
  modules/
    ledger/                      # the core double-entry engine
      ledger.module.ts
      ledger.service.ts          # the ONLY thing importable from outside the module
      entities/
        account.entity.ts
        transaction.entity.ts
        ledger-entry.entity.ts
      internal/                  # posting logic, invariant checks — not exported
      __tests__/
        ledger.service.spec.ts             # unit — TDD lives here
        ledger.invariant.property.spec.ts   # property-based
    payments/
      adapters/
        payment-provider.interface.ts
        kora.adapter.ts
        fake.adapter.ts
    auth/
    kyc/
      adapters/
        kyc-provider.interface.ts
        kora-sandbox-kyc.adapter.ts
        fake-kyc.adapter.ts
    fraud/
    social/
    billsplit/
    scheduling/
  shared/
    events/
      domain-events.ts           # typed event catalog — FundingCompletedEvent, etc.
      event-bus.module.ts        # wraps BullMQ so modules never touch BullMQ directly
    primitives/                  # Money, TransactionType, KycTier — freely importable by any module
  common/                        # guards, interceptors, filters — genuinely cross-cutting
test/
  integration/                   # DB-backed, cross-module seams — not owned by any one module
  contract/                      # against Kora's real sandbox, separate slower cadence

```

Rules that make this real rather than aspirational:

- **A module's public surface is exactly one exported service.** TypeScript has no enforced "module-private" concept — nothing stops one module importing another's internals except tooling. `eslint-plugin-boundaries` (or `dependency-cruiser`) config enforces this in CI: a build fails if a module reaches past another module's exported service.
- **Dependency direction is a rule, not just "modules shouldn't touch each other."** Ledger, Payments, and Auth are core. Fraud, Social, BillSplit, and Scheduling are peripheral and may depend on core (Fraud reads balances via Ledger's service) — core must never import from peripheral. Encode this in the same lint config as an explicit constraint, not a convention someone has to remember.
- **Cross-module references are plain UUIDs, never a DB-level foreign key.** Same-module references (e.g. `ledger_entries.account_id`) keep real FK constraints. Cross-module references (e.g. `bill_split_participants.transactionId`, which points at something Ledger owns) don't — a real FK can't survive the day that table moves to its own database, and the discipline costs nothing to build in now. See [ADR-0002](adr/0002-cross-module-references-and-relation-decorators.md) for the entity-modeling consequence — TypeORM relation decorators follow the same split, additive only where a real FK backs them.
- **Cross-module side effects are async domain events, not direct synchronous calls.** A P2P transfer's ledger write is synchronous and atomic, inside the Ledger module (must be — it's the money). Everything downstream of it — feed updates, notifications, fraud-rule evaluation — reacts to a domain event published through the shared BullMQ-backed event bus. Critically, **the event publishes after the originating transaction commits, not during it** — publishing inside the transaction means a downstream reaction can fire for a transaction that then rolls back, which is a subtle, easy-to-introduce correctness bug. This async seam is also exactly what becomes a real message broker (SQS/NATS/etc.) if a module is ever actually extracted into its own service — swapping the transport is small; retrofitting a synchronous call into an async boundary after the fact is not.
- **Shared primitives are the one deliberate exception to isolation.** `Money`, `TransactionType`, `KycTier`, and similar shared domain vocabulary — some pure types, some (like `Money`) small value objects with real behavior — live in `shared/primitives/` and any module may import them. `primitives/`, not `types/`, because the folder isn't just type declarations — the isolation rule being carved out here is about behavior and state living in a *module*, not about whether the shared thing itself has logic.

Worth naming directly: the schema as it's evolved through this document already falls along these exact lines — Ledger, Auth, KYC, Fraud, Social, BillSplit, and Scheduling each own a clearly scoped set of tables. That's what happens when each phase's tables get scoped to what that phase actually needed; it wasn't a separate design exercise.

### Testing strategy

TDD is concentrated where it earns its keep — the service layer doing actual money logic (fee splits, ledger posting, tier-limit windows) — not applied as blanket ceremony to controllers and DTO wiring, where it mostly tests framework glue rather than logic.


| Layer          | What it covers                                                                                                                                                                                    | Where it lives                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Unit (TDD)     | Ledger math, fee calculations, limit-window logic                                                                                                                                                 | Co-located `__tests__/` per module                                               |
| Integration    | Full service methods against a real test Postgres (Testcontainers) — proves idempotency and atomicity against an actual DB engine, not a mock                                                     | `test/integration/`, not owned by any one module since these are about the seams |
| Contract       | Confirms `KoraAdapter`/`KoraSandboxKycProvider` still match what `FakeAdapter`/`FakeKycProvider` assume — run against Kora's real sandbox                                                         | `test/contract/`, slower cadence (nightly/pre-release), not per-commit           |
| Property-based | Generates random sequences of valid operations (funding, P2P, withdrawal, random order and amounts) and asserts the §4.3 invariant never breaks, rather than relying only on hand-picked examples | Alongside ledger unit tests, using `fast-check`                                  |


The `PaymentProviderAdapter`/`KycProvider` interfaces already in the design (§3.6, Phase 6) are what make unit and integration tests fast and network-free in the first place — that was always their second job, not just enabling a future provider swap.

### CI Pipeline — **[v7, new]**

The four test layers above don't all run on the same cadence:

- **Every PR:** module-boundary lint + unit tests + integration tests — fast enough to gate every commit
- **Nightly / pre-release:** contract tests against Kora's real sandbox + a higher-iteration property-based fuzz run — slower and network-dependent, don't belong gating every commit

---

*Document version: 7.0 — pre-development gap check: secrets/key management, migration discipline for the ledger, database backups with PITR, error tracking, OpenAPI docs, explicit CI cadence, a data-protection nuance distinct from financial licensing, and a design-vs-build-order note — on top of v6's modular monolith + TDD strategy, v5's deferred fraud prevention and frontend/client notes, v4's full auth/MFA design, v3.1's provider-agnostic design, and v2's architecture review fixes.*