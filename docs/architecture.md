# Cliqpay — Project Documentation

> Cliqpay is a production-grade peer-to-peer payment platform. A Venmo-equivalent for Africa — built on NestJS, PostgreSQL, TypeORM, and Kora.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Core Concepts](#3-core-concepts)
4. [Financial Architecture](#4-financial-architecture)
   - [Account Model](#41-account-model)
   - [Transaction Types](#42-transaction-types)
   - [The Invariant](#43-the-invariant)
5. [Database Schema](#5-database-schema)
6. [Phased Development Plan](#6-phased-development-plan)
7. [Production Considerations](#7-production-considerations)
8. [Feature Reference](#8-feature-reference)

---

## 1. Project Overview

Cliqpay is a production-grade virtual wallet and peer-to-peer payment platform built for real users across Africa. Users can fund their wallets, send and receive money from other Cliqpay users, split bills, withdraw to their bank accounts, and interact with a social transaction feed — all in a secure, reliable, and scalable system.

**Payment Provider:** [Kora](https://korahq.com) — chosen for multi-country support without per-country verification requirements, and built-in KYC/KYB verification APIs.

**Target Market:** Nigeria first, with multi-currency and multi-country support built into the architecture from the start.

**Production Standards This System Is Held To:**
- Financial correctness — double-entry ledger, no money created or destroyed
- Reliability — idempotent operations, atomic transactions, graceful failure handling
- Security — JWT with refresh rotation, webhook signature verification, KYC-gated limits
- Auditability — full ledger trail, reconcilable at any point in time
- Scalability — architecture that supports growth without fundamental redesign

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Framework | NestJS |
| Database | PostgreSQL |
| ORM | TypeORM |
| Payment Provider | Kora |
| Job Queues | BullMQ |
| Auth | Custom JWT (access + refresh tokens) |
| Language | TypeScript |
| Caching | Redis |
| Email | Brevo (transactional) |
| Logging | Pino |
| Monitoring | Pino structured logs (deferred) |
| Deployment | AWS EC2 (deferred) |

---

## 3. Core Concepts

### 3.1 Double-Entry Ledger

Cliqpay models money using **double-entry bookkeeping** — the same system used by real financial institutions. The core rule:

> Every transaction affects at least two accounts, and the total must always balance to zero.

Money never appears or disappears. It always moves *from* one account *to* another. Every movement is recorded on both sides.

### 3.2 Account Types

Accounts have types that determine how they behave:

| Type | Description | Example |
|---|---|---|
| **Asset** | Money you own or that is held for you | `kora_float` |
| **Liability** | Money you owe to others | `user_wallet` |
| **Equity** | Accumulated earnings | `fee_income` |

The fundamental equation that must always hold:

```
Assets = Liabilities + Equity
```

### 3.3 Cached Balance

Computing balance by summing ledger entries on every read is expensive. Instead, each wallet stores a **cached balance** column that is updated atomically inside the same database transaction as the ledger entries. The ledger remains the source of truth — the cached balance is only for fast reads.

### 3.4 Idempotency

Payment operations must never execute twice. Every transaction carries a unique **idempotency key**. Webhook events from Kora are checked against this key before processing — duplicate events are silently ignored.

### 3.5 Atomicity

Every money movement that touches multiple accounts must succeed or fail as a unit. If any part fails, everything rolls back. No partial state is ever persisted.

---

## 4. Financial Architecture

### 4.1 Account Model

**System Accounts** — created once on application boot, not tied to any user:

| Account | Type | Purpose |
|---|---|---|
| `kora_float` | Asset | Real money Kora holds on behalf of Cliqpay |
| `fee_income` | Equity | Platform fees earned by Cliqpay |

**User Accounts** — one wallet created per user on registration:

| Account | Type | Purpose |
|---|---|---|
| `user_wallet` | Liability | What Cliqpay owes each user |

> A user wallet is a **liability** because the balance belongs to the user, not Cliqpay. Cliqpay is merely holding it.

---

### 4.2 Transaction Types

**Fee Policy:**
- Kora provider fees are passed directly to the user (visible in transaction detail via metadata)
- Cliqpay platform fees are charged separately per transaction type
- Platform profit accumulates in `fee_income`

---

#### Funding
*User deposits money into their Cliqpay wallet via Kora.*

Kora charges a provider fee on the gross amount. The user receives the net amount.

```
DEBIT  kora_float      net_amount
CREDIT user_wallet     net_amount

metadata: {
  gross_amount,
  kora_fee,
  kora_reference
}
```

**Balance effect:**
- `kora_float` ↑ — Kora holds more real money for Cliqpay
- `user_wallet` ↑ — Cliqpay owes the user more

**Equation check:** Both sides of `Assets = Liabilities` increase equally. ✓

---

#### P2P Transfer
*User sends money to another Cliqpay user. Cliqpay charges a platform fee.*

```
DEBIT  sender_wallet    amount + platform_fee
CREDIT recipient_wallet amount
CREDIT fee_income       platform_fee

metadata: {
  platform_fee,
  note,
  is_public
}
```

**Balance effect:**
- `sender_wallet` ↓
- `recipient_wallet` ↑
- `fee_income` ↑
- `kora_float` unchanged — money never left Cliqpay's system

**Equation check:** Liability decreases on one side, increases on another. Fee_income (equity) absorbs the difference. ✓

---

#### Withdrawal
*User withdraws money to their bank account. Both Kora and Cliqpay charge fees.*

The user is debited the full amount including both fees. Kora sends the net amount to the bank and keeps their fee. Cliqpay keeps its platform fee.

```
DEBIT  user_wallet      amount + platform_fee + kora_fee
CREDIT kora_float       amount + kora_fee        (Kora sends `amount`, keeps `kora_fee`)
CREDIT fee_income       platform_fee

metadata: {
  bank_account,
  kora_fee,
  platform_fee,
  net_amount,
  kora_reference
}
```

**Balance effect:**
- `user_wallet` ↓
- `kora_float` ↓ (real money leaves Kora to the user's bank)
- `fee_income` ↑

**Equation check:** Assets and liabilities both decrease. Fee_income absorbs platform fee. ✓

---

#### Profit Withdrawal
*Cliqpay moves accumulated platform earnings out for operations.*

This has nothing to do with users. It moves money from Kora (where it's been sitting as part of the float) to Cliqpay's own bank account.

```
DEBIT  fee_income      amount
CREDIT kora_float      amount
```

**Balance effect:**
- `fee_income` ↓ — equity is reduced
- `kora_float` ↓ — real money leaves Kora
- All user wallets untouched

**Equation check:** Equity decreases, assets decrease equally. User liabilities never touched. ✓

---

### 4.3 The Invariant

At any point in time, this must hold:

```
kora_float = Σ(all user wallet balances) + fee_income
```

In plain terms: everything Kora holds for Cliqpay is either owed to a user or earned by the platform. Nothing more, nothing less.

If this ever breaks, money was either created or destroyed somewhere in the system. This is the primary reconciliation check.

---

## 5. Database Schema

```
accounts
  id                uuid PK
  type              enum (asset | liability | equity)
  name              varchar
  user_id           uuid FK nullable   -- null for system accounts
  currency          varchar default 'NGN'
  balance           decimal default 0  -- cached, updated atomically
  created_at        timestamp

transactions
  id                uuid PK
  reference         varchar unique      -- idempotency key
  type              enum (funding | p2p_transfer | withdrawal | bill_split | scheduled | profit_withdrawal)
  status            enum (pending | completed | failed | reversed)
  amount            decimal
  currency          varchar
  sender_wallet_id  uuid FK nullable
  recipient_wallet_id uuid FK nullable
  metadata          jsonb               -- kora_reference, fees, note, is_public, etc.
  created_at        timestamp
  updated_at        timestamp

ledger_entries
  id                uuid PK
  transaction_id    uuid FK
  account_id        uuid FK
  direction         enum (debit | credit)
  amount            decimal
  running_balance   decimal             -- balance of this account after this entry
  created_at        timestamp
```

> **Note:** `accounts` serves both system accounts (kora_float, fee_income) and user wallets. The `user_id` is null for system accounts.

---

## 6. Phased Development Plan

Each phase exits with a working, production-quality slice of the system. No phase begins until the previous one is stable, tested, and meets production standards — proper error handling, input validation, logging, and test coverage.

---

### Phase 1 — Foundation
**Goal:** Users can register, log in, and have a wallet. No money moves yet.

- [ ] NestJS project structure — modules, config, environment
- [ ] PostgreSQL + TypeORM setup, migrations
- [ ] Database schema implementation
- [ ] Seed system accounts (`kora_float`, `fee_income`) on app boot
- [ ] Auth — register, login, logout
- [ ] JWT access tokens + refresh token rotation
- [ ] Password hashing (bcrypt)
- [ ] Rate limiting on auth endpoints
- [ ] Input validation (class-validator) on all endpoints
- [ ] User profile endpoints
- [ ] Wallet auto-created on registration (NGN default)
- [ ] Balance endpoint
- [ ] Global exception filter — consistent error responses
- [ ] Request logging

**Key concepts:** NestJS architecture, TypeORM migrations, JWT auth, double-entry schema design

---

### Phase 2 — Wallet Funding
**Goal:** A user can fund their wallet. Balance updates. History shows it.

- [ ] Kora payment initialization — generate payment link
- [ ] Webhook receiver endpoint
- [ ] Kora webhook signature verification
- [ ] Idempotency — deduplicate webhook events by reference
- [ ] Ledger entries for funding transaction (atomic)
- [ ] Transaction history endpoint (paginated)
- [ ] Email notification on successful funding

**Key concepts:** Webhooks, idempotency, event-driven money movement, atomic writes

---

### Phase 3 — P2P Transfers
**Goal:** Two users can move money between each other.

- [ ] Send money by username or email
- [ ] Request money from another user
- [ ] Balance check before debit
- [ ] Atomic ledger entries — sender debit, recipient credit, fee to fee_income
- [ ] Pessimistic locking — prevent race conditions on wallet balance
- [ ] Transaction history — sent and received correctly distinguished
- [ ] In-app notifications
- [ ] Email notification on send and receive

**Key concepts:** Atomicity, pessimistic locking, race conditions, ledger correctness

---

### Phase 4 — Withdrawal
**Goal:** A user can withdraw their balance to a bank account.

- [ ] Save bank account (Kora bank account verification)
- [ ] Initiate withdrawal via Kora payout API
- [ ] Webhook for payout success/failure
- [ ] Ledger entries for withdrawal + fees
- [ ] Handle failed payouts — reverse ledger entries, restore balance atomically
- [ ] Withdrawal history
- [ ] Email notification on withdrawal initiated and completed

**Key concepts:** Payout APIs, failure handling, transaction reversal, reconciliation

---

### Phase 5 — KYC Tiers
**Goal:** Users have tiers. Limits are enforced per tier.

- [ ] Tier model — Tier 0 (unverified), Tier 1 (BVN), Tier 2 (full ID)
- [ ] Kora KYC verification integration
- [ ] Daily/transaction limits enforced per tier per operation type
- [ ] Tier upgrade flow
- [ ] Limit exceeded error responses with clear messaging

**Key concepts:** State machines, access control, KYC API integration

---

### Phase 6 — Social Layer
**Goal:** The Venmo-style social feed works.

- [ ] Transaction notes and descriptions
- [ ] Public/private toggle per transaction
- [ ] Follow/unfollow users
- [ ] Activity feed — public transactions from followed users (paginated)
- [ ] Reactions and comments on transactions

**Key concepts:** Social graph, feed architecture, privacy controls

---

### Phase 7 — Bill Splitting
**Goal:** A user can split a bill with multiple people and track payment.

- [ ] Create a split request — total amount, participants, description
- [ ] System calculates each participant's share
- [ ] Each participant receives a payment request
- [ ] Track paid/unpaid status per participant
- [ ] Initiator notified as each person pays
- [ ] Auto-close split when all participants have paid
- [ ] Expire uncompleted splits after a configurable window

**Key concepts:** Group state management, distributed transaction logic, event tracking

---

### Phase 8 — Scheduled & Recurring Payments
**Goal:** Payments can be automated.

- [ ] Schedule a one-time future payment
- [ ] Set up recurring payments — weekly, biweekly, monthly
- [ ] BullMQ job processor setup
- [ ] Handle failures on scheduled payments — retry logic, notifications
- [ ] Cancel or modify scheduled payments
- [ ] Audit log of all scheduled payment executions

**Key concepts:** Job queues, background processing, reliability, retry strategies

---

### Phase 9 — Multi-Currency Wallets
**Goal:** Users can hold and transact in multiple currencies.

- [ ] User can create additional currency wallets (USD, GHS, KES, etc.)
- [ ] Fund foreign currency wallet via Kora
- [ ] Transfer between same-currency wallets
- [ ] Cross-currency transfers — FX rate from Kora, platform spread
- [ ] Ledger correctly records currency on all entries
- [ ] Balance per currency on user profile

**Key concepts:** Multi-currency modeling, FX rates, currency-aware ledger design

---

## 7. Production Considerations

These are non-negotiable standards applied across all phases, not deferred to a "hardening" phase.

### Security
- All endpoints protected by JWT guard except public routes
- Webhook endpoints verify Kora signature on every request — reject anything that fails
- Passwords hashed with bcrypt, never stored or logged in plaintext
- Sensitive fields (bank account numbers, BVN) encrypted at rest
- Rate limiting on auth, payment initiation, and KYC endpoints
- No financial amounts accepted from the client for webhook-confirmed transactions — always derive from Kora's payload

### Data Integrity
- All money movements wrapped in database transactions — partial writes never committed
- Pessimistic locking on wallet rows during concurrent balance updates
- Idempotency keys on all payment operations — safe to retry without side effects
- Ledger entries are append-only — never updated or deleted
- Reconciliation check (the invariant) runnable on demand and schedulable as a background job

### Error Handling
- Global exception filter returns consistent error shape across all endpoints
- Payment failures handled explicitly — no silent swallowing of Kora errors
- Failed transactions reversed atomically — no stuck pending states
- All external API calls (Kora) wrapped with timeout and retry logic

### Observability
- Pino for structured JSON logging throughout the application
- Request logging on all endpoints — method, path, status code, duration
- Transaction lifecycle logged at each state change (pending → completed → failed)
- Webhook events logged before and after processing
- All Kora API calls logged with request/response (sensitive fields redacted)
- Reconciliation results logged and reviewable
- Full monitoring setup deferred — Pino logs serve as the observability layer for now

### API Design
- Consistent response envelope across all endpoints
- Pagination on all list endpoints
- Versioned API routes (`/v1/`)
- Comprehensive input validation with descriptive error messages

---

## 8. Feature Reference

| Feature | Phase | Core Concept Learned |
|---|---|---|
| Auth (JWT + refresh) | 1 | Token security, rotation |
| Wallet creation | 1 | Schema design, double-entry foundation |
| Wallet funding | 2 | Webhooks, idempotency |
| P2P transfers | 3 | Atomicity, race conditions |
| Money requests | 3 | Request/response payment flows |
| Withdrawal | 4 | Payout APIs, reversal logic |
| KYC tiers + limits | 5 | State machines, access control |
| Social feed | 6 | Feed architecture, social graph |
| Bill splitting | 7 | Group state, distributed transactions |
| Scheduled payments | 8 | Job queues, background processing |
| Multi-currency | 9 | FX modeling, currency-aware ledger |

---

*Document version: 1.0 — to be updated as architecture decisions evolve.*
