# Kora refunds: sandbox research spike

Captured 2026-10-23 against `https://api.korapay.com/merchant/api/v1` with the sandbox secret key. Fixtures: `test/fixtures/kora-refunds/` (sanitized: no key or auth header, webhook signatures replaced by `<hmac-sha256-hex>`, tunnel host masked as `tunnel.example.invalid`, merchant name masked; response headers reduced to `content-type`/`x-request-id`). Input to issue #48 (hold-then-refund for a funding that would breach the balance cap); the design is in [kora-refunds-design.md](kora-refunds-design.md).

**72 API calls** were made, all sandbox, sequential: `POST /refunds/initiate` 24, `GET /refunds/:ref` 11, `GET /refunds` (list) 3, `GET /balances` 14, `GET /charges/:ref` 13, `POST /charges/bank-transfer` 5, `POST /charges/initialize` 2. Twelve webhook deliveries were captured (4 `charge.success`, 7 `refund.success`, 1 `refund.failed`). Real money was never involved: the sandbox NGN balance moved from 6,815,970.55 to 6,816,610.30, exactly as the refund arithmetic below predicts.

Legend: **[V]** verified by a captured request/response in this spike. **[D]** docs only, not verified.

## 1. Summary: what is verified and what is not

| Area | Status |
|---|---|
| Test-mode guard | [V] key has the `sk_test_` prefix (boolean check only, key never printed); `GET /balances` returned the sandbox defaults (every non-NGN currency at exactly 5,000,000, `issuing_balance` 1000 on USD). `docs/e2e-real-providers.md` also records the sandbox key as `sk_test_...`. Kora's docs do not state the prefix rule. |
| Refund initiate (full, partial, with and without `completion_status`), status fetch by reference, list | [V] |
| Refund webhooks `refund.success` / `refund.failed`: payload, header, signature over `data` | [V] 8 deliveries captured; the existing `KoraAdapter.verifyWebhookSignature` scheme validates every one (checked with the real key inside the capture process) |
| `webhook_url` overrides the dashboard URL | [V] |
| Fee behaviour on a refunded payment | [V] for bank-transfer API charges (section 3) and, since issue #66, for **hosted-checkout card and bank-transfer charges** (section 9). Live mode [D]. |
| Timing | [V] sandbox only: instant. Live timing [D]/unknown. |
| Error and rejection matrix | [V] mostly (section 5); Kora-balance-too-low and the refund window are not triggerable |
| Refund of a hosted-checkout charge (`POST /charges/initialize`, the charge type Cliqpay creates) and of a card payment | [V] issue #66, 2026-10-27 (section 9) |
| Minimum NGN 100 | The sandbox does **not** enforce it (a NGN 99 refund succeeded). Live behaviour [D]. |

### Most important findings

1. **Kora does not return its fee on a refund, and a refund with no `amount` returns the payer's gross payment (`amount_paid`, including the fee).** With a customer-bears-cost charge (paid 1,053.75, merchant credited 1,000.00, fee 53.75), the default full refund debited the merchant balance by 1,053.75: Cliqpay would be out of pocket by the fee. Passing `amount` equal to the credited principal (1,000.00) debits exactly 1,000.00: Cliqpay is cost-neutral and the payer bears the fee. A merchant-bears-cost charge refunded in full cost the merchant the fee too (credited 946.25, refunded 1,000.00). Details in section 3.
2. **The refund webhook does not carry our payment reference.** `data.payment_reference` is a Kora-internal id (`KPY-CA-...`), not the reference we sent when creating the charge (which the status endpoint and the initiate response do echo). The only usable correlation key on the webhook is `data.reference`, the refund reference, so it must be derived deterministically from something we own.
3. **Refund timing in the sandbox is instant.** The initiate response says `processing`, but the refund was `success` on the first status fetch (same second) and the webhook arrived 0.2 to 0.35 s after the initiate call. Kora's merchant balance was already debited at initiate time.
4. **A refund reference can never be reused, even after a failure** (HTTP 409 `AA021`, "Refund already exists with reference ..."), including across payments. A failed refund can be retried with a **new** reference. There is also a **per-payment cool-down of about 60 s** after any refund attempt (HTTP 429, "Possible duplicate refund detected ... try again in N seconds").
5. **The webhook rides the existing endpoint, same signature.** `refund.success`/`refund.failed` arrive on the dashboard webhook URL with `x-korapay-signature` = HMAC-SHA256 of the `data` slice, the same scheme the app already verifies. With `webhook_url` set on the refund, the delivery goes only to that URL.
6. **Docs vs reality:** the minimum of NGN 100 is not enforced in the sandbox; webhook timestamps are `created_at`/`completed_at` (docs: `refund_date`/`completion_date`); a refund reference of 64 characters gives an HTTP 500 (`AA029`), not a validation error; the initiate response has an undocumented `channel: "api"`; a bank-transfer charge defaults to `merchant_bears_cost: true` (docs: `false`).

## 2. Endpoints, auth, envelope

| Item | Finding |
|---|---|
| Auth | `Authorization: Bearer <secret key>` [V], same as every existing adapter call. |
| Initiate | `POST /refunds/initiate`; body `payment_reference` (the merchant reference of the charge, [V] works with a bank-transfer charge reference), `reference`, optional `amount` (number or numeric string, both accepted [V]), `reason`, `webhook_url`; sandbox-only `completion_status` (`success`/`failed`) and `status_reason`. [V] |
| Initiate response | `{ status: true, message: "Refund successfully initiated", data: { refund_reference, refund_date, status: "processing", payment_reference, reason?, amount_returned, channel: "api", currency } }`. `amount_returned` is a number (1053.75). `reason` is absent when none was sent. `fixtures: refund.initiate.*` |
| Status | `GET /refunds/:reference` (by refund reference) [V]: `data { amount "1053.75" (string), status, currency, destination "customer", reference, reason, payment_reference (ours), transaction_amount "1053.75" (the payment's amount_paid, string), payment_method "bank_transfer", created_at "YYYY-MM-DD HH:MM:SS", completed_at }`. Local time (WAT) without a zone here, while the initiate response and the webhook use ISO 8601 UTC. |
| List | `GET /refunds?limit=N` [V]: `data { has_more, refunds[ { pointer "cus_54A", reference, status, amount, currency, payment_reference, reason (null), transaction_amount, created_at, completed_at } ] }`. `status=failed` gives HTTP 400 `AA027`, "status must be an array", so the filter needs array syntax [D, not retried]. Not needed by the design. |
| Statuses | `processing` (initiate response only), `success`, `failed` [V]. |
| Envelope | Success `{status: true, message, data}`; failure `{status: false, code: "AAxxx" or error: "...", message, data: null}`. Validation errors: HTTP 422 `error: "validation_error"`, `data: { <field>: { message } }`. |
| Latency | Initiate 200 to 2,200 ms (median about 400 ms) in 24 calls. |

## 3. Fee and amount behaviour: the evidence

All with bank-transfer API charges (`POST /charges/bank-transfer`), amount NGN 1,000: fee NGN 50 + VAT 3.75 = **53.75**. Balances are sandbox NGN `available_balance` (`balances.ngn.sequence.json`).

| Case | Charge | Merchant credited | Refund call | Merchant balance change | Result |
|---|---|---|---|---|---|
| A: merchant bears cost (Kora's default for this endpoint) | payer paid 1,000.00 | 946.25 (1,000 minus 53.75) | full, no `amount` (`amount_returned` 1,000) | **-1,000.00** | refund success. The merchant is out 53.75 net. |
| B: customer bears cost | payer paid 1,053.75, `amount` 1,000.00, `fee` 53.75 | 1,000.00 | full, no `amount` (`amount_returned` **1,053.75**) | **-1,053.75** | refund success. The merchant is out 53.75 net. |
| C: customer bears cost | same as B | 1,000.00 | `amount: 1000` (the principal) | **-1,000.00** | refund success; the charge then reports a **remaining refundable 53.75** (HTTP 409 `AA021`, "The maximum refundable amount for this transaction is NGN 53.75"). A "full refund" call on the remainder is rejected (HTTP 422 `AA025`) and wants an explicit amount of at most 53.75. |
| D: failed refund (`completion_status: failed`) | same as B | 1,000.00 | full | **0** | `refund.failed`, nothing debited |

Conclusions, with their limits:

- The fee is never returned in these runs. The refundable ceiling is `amount_paid` (payer's gross), the refund is debited from the merchant balance at initiate time, and the merchant's pay-in fee is not credited back. [V] for bank-transfer charges in the sandbox.
- Whether a card charge or a hosted-checkout charge behaves the same, whether live mode returns the fee, and whether Kora charges a separate refund fee are **unknown** (no refund fee appeared in any balance delta here; the live fee schedule is not in the docs). Open questions 1 to 3 in section 10.
- On `GET /charges/:ref`, the charge stays `status: "success"` with the same `amount_paid`/`fee` after a full refund (`charge.verify.bt2.after_full_refund`): the funding verify call cannot be used to detect a refund.
- Not tested: a hosted-checkout charge, where `amount_paid`, `amount` and `fee` are shaped as ADR-0007 recorded (verify: amount 1000.00, amount_paid 1013.97, fee 13.97; webhook amount 2500 for a 2500 charge). The bank-transfer API's `charge.success` webhook reports `amount` = gross (1,053.75) in the customer-bears case, which is **not** the checkout webhook's convention and would trip the existing amount-mismatch guard in `postFunding` if Cliqpay ever created charges through that API.

## 4. Webhooks [V]

Delivered to the dashboard URL (path `/webhooks/kora` on the reserved host) for refunds created without `webhook_url`; delivered to the `webhook_url` path only (nothing to the dashboard URL) when it was set; `charge.success` went to the charge's `notification_url`. All were `POST`, `content-type: application/json`, header `x-korapay-signature`. No other Kora-specific header was present (no event id, no timestamp).

```json
{"event":"refund.success","data":{"amount":1000,"status":"success","currency":"NGN","reference":"RFD-cliqpay-spike-bt-1792740961307-1","payment_reference":"KPY-CA-C366jmDIXmLwxtV","created_at":"2026-10-23T07:37:06.037Z","completed_at":"2026-10-23T07:37:06.078Z"}}
{"event":"refund.failed","data":{"amount":1053.75,"status":"failed","status_reason":"spike simulated failure","currency":"NGN","reference":"RFD-c3-f1","payment_reference":"KPY-CA-9IOSxwj1cNH2EFr","created_at":"...","completed_at":"..."}}
```

- `data.reference` echoes the refund reference exactly as sent. `data.payment_reference` is Kora's internal charge id, never ours.
- `amount` is a JSON number, equal to the refund amount, not the original payment. No `fee` field.
- `status_reason` appears on the failure (it was simulated through `completion_status`/`status_reason`; the shape of a real failure's reason is unobserved).
- **Signature [V]:** HMAC-SHA256 with the secret key over the top-level `data` value, hex digest, in `x-korapay-signature`: valid for all 12 deliveries, both over the raw `data` slice (what `KoraAdapter.verifyWebhookSignature` computes) and over `JSON.stringify(data)`. The existing verification covers refund events unchanged.
- Delivery latency for refunds: 0.2 to 0.35 s after the initiate call (sandbox). Charge webhooks arrived about 30 s after a bank-transfer charge was created (docs say 2 minutes; the status endpoint reported success on the first poll at +40 s).
- Retries: the docs say Kora retries a non-200 or a timeout "periodically within 72 hours". Not tested here.
- The existing `PaymentsService.handleKoraWebhook` already logs and ignores `refund.*`; the dispatch gap is the only application change needed to receive them.

## 5. Error and rejection matrix [V unless noted]

| Scenario | HTTP | Body |
|---|---|---|
| Unknown payment reference | 404 | `code AA026`, "Transaction not found" |
| Payment exists but is unpaid (checkout initialised, never paid) | 404 | same: "Transaction not found" |
| Refund status for an unknown reference | 404 | `code AA026`, "Refund not found" |
| Amount above what was paid | 422 | `code AA025`, "Refund amount can't be more than NGN 1053.75" |
| Amount above what is still refundable | 409 | `code AA021`, "The maximum refundable amount for this transaction is NGN 53.75" |
| Payment already fully refunded | 409 | `code AA021`, "A full reversal has already been processed for this transaction" |
| "Full" refund when only a remainder is left | 422 | `code AA025`, "A full refund cannot be initiated ... Please enter an amount less than or equal to NGN 53.75" |
| Duplicate refund reference (same payment, other payment, or a **failed** refund's reference) | 409 | `code AA021`, "Refund already exists with reference RFD-..." |
| Second attempt on the same payment within about 60 s of any attempt (even after a failed one) | 429 | `error: too_many_requests`, "Possible duplicate refund detected, please confirm and try again in 56 seconds". The duplicate-reference 409 is evaluated first. |
| Refund reference of 64 characters | 500 | `code AA029`, "Internal server error..." (not a validation error) |
| Missing `reference` / `payment_reference` | 422 | `validation_error` with the field |
| Negative amount | 422 | `validation_error`, "amount must be greater than or equal to 0" |
| Amount below NGN 100 (99.00) | **200** | accepted and completed: the documented minimum is not enforced in the sandbox |
| Amount as a numeric string | 200 | accepted |
| Merchant balance too low to refund | [D] not triggerable (sandbox balance is about 6.8M) | message and code unknown |
| Refund window for old payments | [D] not triggerable | unknown |

## 6. Simulating outcomes

`completion_status: "success" | "failed"` (with optional `status_reason`) on initiate works as documented and triggers the matching webhook within a fraction of a second. **Without** `completion_status` the sandbox also completes the refund as `success` immediately, so the `processing`-for-a-while path and any real failure are not reproducible in the sandbox.

A failed refund is retriable: after the cool-down, a new reference on the same payment succeeded (`RFD-c3-s2` after `RFD-c3-f1` failed), and the failed attempt moved no money.

## 7. Charge types and how a charge was completed without card entry

No card data was typed or sent. `POST /charges/bank-transfer` (the "Pay with Bank Transfer" API: `reference` of at least 8 characters, `amount`, `currency: NGN`, `customer { email, name }`, optional `notification_url`, `merchant_bears_cost`, `auto_complete`) returned a virtual account; with the default `auto_complete` the sandbox settled it by itself about 30 s later and sent `charge.success` to the `notification_url`. This worked on the first try, with the account as it is. Quirks: it defaults `merchant_bears_cost` to `true`; `fee` 50 plus `vat` 3.75; the payer is "Kora Sandbox".

Refunds were therefore verified against bank-transfer API charges only. Cliqpay's real flow (hosted checkout, `POST /charges/initialize`, customer pays amount plus fee) was exercised only up to the checkout URL (two unpaid charges). See section 9.

## 8. Kora's balance and refunds

- The merchant balance is debited **at initiate time**, before any webhook (case A: balance dropped by 1,000.00 between the initiate call and the first status fetch). `pending_balance` stayed 0 throughout.
- A failed refund left the balance unchanged (case D); whether live mode debits first and credits back on failure is unobserved.
- For reconciliation: between initiate and completion the provider balance is lower than the ledger float by the refund amount. In the sandbox this window is under a second; in live it is whatever `processing` lasts.

## 9. Hosted-checkout charges: card and bank transfer (issue #66, 2026-10-27)

Six charges created with `POST /charges/initialize` (the call `KoraAdapter.initiatePayment` makes), paid by a person on Kora's test checkout: Kora's published successful Visa test card, and "Pay with Bank Transfer". 35 sandbox calls in total (25 for the first four charges, 10 for the two webhook-capture charges), no tunnel for the first four and the reserved tunnel for the last two. Fixtures: `test/fixtures/kora-refunds/checkout.*.json`.

**The fee is borne by whoever the request says, and Cliqpay's request does not say.** `KoraAdapter.initiatePayment` does not send `merchant_bears_cost`. Kora's docs say it defaults to `true`, and the first two checkout charges (no flag) behaved that way: the payer paid exactly the amount, and Kora credited the merchant the amount minus its fee. ADR-0007 recorded the opposite on 2026-07-30 (a checkout where `amount_paid` was 1,013.97 for a 1,000 charge), so the effective default has changed since; the account setting or Kora's default is the likely cause and is a question for Kora (section 10).

| Charge (NGN 1,000) | `amount_paid` | `fee` | Merchant balance credited | Refund call | Merchant balance change | Remaining refundable |
|---|---|---|---|---|---|---|
| Card, no flag (merchant bears) | 1,000.00 | 13.97 | 986.03 | no `amount` (`amount_returned` 1,000) | -1,000.00 | none |
| Transfer, no flag (merchant bears) | 1,000.00 | 53.75 | 946.25 | `amount: 1000` | -1,000.00 | none |
| Card, `merchant_bears_cost: false` | 1,013.97 | 13.97 | 1,000.00 | `amount: 1000` (the principal) | **-1,000.00** | 13.97 (the 422 "A full refund cannot be initiated ... less than or equal to NGN 13.97") |
| Transfer, `merchant_bears_cost: false` | 1,053.75 | 53.75 | 1,000.00 | no `amount` (`amount_returned` **1,053.75**) | **-1,053.75** | none |

What it shows:

- **Principal refund confirmed on a hosted-checkout card charge** (row 3): refunding exactly the credited amount moves Kora's balance by exactly that amount, so Cliqpay bears nothing, and Kora does not return its fee.
- **The default refund returns the payer's gross on a checkout transfer too** (row 4), as on bank-transfer API charges: omitting `amount` would cost Cliqpay the fee. The adapter must keep sending `amount`.
- When the merchant bears the fee (rows 1 and 2) the principal equals the payer's payment, so the principal refund makes the payer whole and the fee is simply a cost Cliqpay already carried when it took the payment.
- All four refunds completed within the first status read (`channel: "modal"`, not `"api"`, in the initiate response); the charges keep `status: "success"` afterwards.
- Cards: the fixtures contain Kora's published test card (first six 408412, last four 2787), which is public.

### Captured webhooks for hosted-checkout card charges

Two further card charges were created with `notification_url` on the tunnel and refunded by principal; every delivery's signature validated (HMAC over `data`).

```json
merchant bears the fee (no flag):   {"event":"charge.success","data":{"reference":"cliqpay-66c-default-...","payment_reference":"cliqpay-66c-default-...","currency":"NGN","amount":1000,"fee":13.97,"payment_method":"card","status":"success"}}
payer bears the fee (flag false):   {"event":"charge.success","data":{"reference":"cliqpay-66c-payerbears-...","payment_reference":"cliqpay-66c-payerbears-...","currency":"NGN","amount":1013.97,"fee":13.97,"payment_method":"card","status":"success"}}
refund of either:                    {"event":"refund.success","data":{"amount":1000,"status":"success","currency":"NGN","reference":"rfd-66c-...","payment_reference":"KPY-CM-...","created_at":"...","completed_at":"..."}}
```

- **`charge.success.data.amount` is the payer's gross when the payer bears the fee** (1,013.97), and the requested amount when the merchant does. `GET /charges/:ref` reports `amount` 1,000.00 in both cases (`amount_paid` carries the gross). The two sources disagree in the payer-bears configuration.
- The refund webhook has the same shape for card as for bank transfer: our refund `reference`, a Kora-internal `payment_reference` (`KPY-CM-...` for a checkout charge, `KPY-CA-...` for a bank-transfer API charge), no fee field.
- Refund webhooks arrived 0.3 s after the initiate call at the dashboard URL (`/webhooks/kora`); the charge webhooks arrived at the `notification_url` within a second of the payment. Undelivered webhooks from the earlier charges (sent while no tunnel was up) were not redelivered in the few minutes the tunnel was up.

**Consequence beyond refunds (resolved 2026-10-27).** The funding posting credits float with the requested amount and assumes the payer bore the fee. If Cliqpay's charges are merchant-bears-cost, Kora's balance is lower than ledger float by the fee on every funding and the external reconciliation will drift; the held and refunded emails also say "the provider's fee is not refunded", which would be untrue for a payer who paid no fee. Sending `merchant_bears_cost: false` alone would not have been enough: with the payer bearing the fee the `charge.success` webhook reports the payer's gross as `amount`, which `postFunding` would reject against the requested amount, while the poll path, which reads `amount` from the charge, would succeed.

**Fix.** `KoraAdapter.initiatePayment` always sends `merchant_bears_cost: false`, pinning the payer-bears behaviour the funding posting, the reconciliation and the emails assume. `PaymentsService` derives the credited net from a webhook as `amount - fee`, except when the reported amount already equals the requested amount (a charge created before the change, or the merchant bearing the fee), in which case it is used as reported. The ledger's cross-check of the net against the request remains the backstop: an amount that matches neither reading fails the funding without crediting it. The poll path needs no change.

## 10. Questions for Kora support

1. When a charge where the customer bore the fee is refunded, does Kora ever return the pay-in fee to the merchant (immediately, on settlement, never)? Is that the same in live mode and for cards, and does the answer depend on `merchant_bears_cost`?
2. Is there a fee for the refund itself, and what are the refundable amount rules (principal only, or the gross `amount_paid`) in live? Why does the default refund return the gross amount?
3. Is the NGN 100 minimum enforced in live mode? What does it return for a refund below it?
4. How long does a live refund stay `processing` (cards and bank transfers), and is the merchant balance debited at initiate or at completion? Is it credited back on failure?
5. What are the real failure causes (invalid source account, insufficient merchant balance, expired refund window) and their `code`/`message` values? Which of them are permanently terminal and which are retriable?
6. What is the refund window after which a payment can no longer be refunded?
7. Can the refund webhook carry the merchant's payment reference? Today `data.payment_reference` is an internal `KPY-CA-` id.
8. Is the roughly 60 s per-payment cool-down documented, and does it apply to live?
9. Is there an event id or timestamp on webhook deliveries for deduplication (none was observed)?
10. Refund list: the exact array syntax for the `status` filter.
11. Why did the effective default of `merchant_bears_cost` on `POST /charges/initialize` change between 2026-07-30 (payer bore the fee) and 2026-10-27 (merchant bears)? Is it an account setting, and can it be pinned?

## 11. Documentation inconsistencies found

- The docs' initiate sample uses `refund_reference` in the response; the webhook and status use `reference`.
- Webhook timestamps are `created_at`/`completed_at`, not `refund_date`/`completion_date` as the Webhooks page states; the refund reference in the docs' webhook sample (`RFD-API-001`) is just a sample.
- `payment_reference` in the webhook is not the merchant's payment reference (the docs imply it is).
- The documented minimum NGN 100 is not enforced in the sandbox.
- Docs list the HTTP method for refunds only implicitly; `POST` for initiate and `GET` for the others work.
- The bank-transfer docs say `merchant_bears_cost` defaults to `false` and success after 2 minutes; observed default `true` and about 30 s.
- Amount types: number in the initiate response and webhook, string in the status and list responses.
