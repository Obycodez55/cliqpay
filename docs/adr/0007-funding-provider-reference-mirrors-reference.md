# ADR-0007: Funding transactions — `provider_reference` mirrors `reference`, not a distinct Kora ID

**Status:** accepted
**Date:** 2026-07-30

## Context

docs/architecture.md §5 documents `transactions.provider_reference` as "the
provider's own reference for this operation," and the funding posting
example (§4.2) annotates it as `<Kora's own reference for this payment>` —
implying Kora hands back a distinct identifier, separate from Cliqpay's own
`reference` (our idempotency key), that we'd store and later use to
correlate an incoming webhook back to the right transaction.

A real sandbox charge was run against Kora's live sandbox API to confirm
this before building the funding flow against it
(`POST /merchant/api/v1/charges/initialize`, then
`GET /merchant/api/v1/charges/{reference}` once paid). The verify response:

```json
{
  "reference": "cliqpay-test-1785309512",
  "status": "success",
  "amount": "1000.00",
  "amount_paid": "1013.97",
  "fee": 13.97,
  "currency": "NGN"
}
```

The only field present is `reference` — exactly what we sent, echoed back.
There is no separate Kora-generated transaction ID anywhere in this
response, and a real webhook received during the Phase 2 e2e pass (a live
charge, delivered by Kora itself over a public tunnel, not simulated)
confirms the webhook payload carries the same fields — no distinct ID
there either. The one distinct Kora-generated token observed anywhere in
the flow is embedded in the `checkout_url` returned at initialization
(e.g. `.../KPY-PI-2026072907183FId0U33643/pay`) — not returned as a
correlatable field on either the verify endpoint or the webhook payload.

**[Correction, Phase 2 e2e pass]** The webhook payload's `amount`/`fee`
fields are **not** decimal strings like the verify endpoint's — the real
webhook delivered `"amount": 2500, "fee": 34.94` as raw JSON numbers, not
`"amount": "2500.00"`. This ADR originally claimed the webhook "has the
same shape" as the verify response above; that held for field presence
(no distinct ID either way) but not for these two fields' types.
`validateWebhookData` (`payments.service.ts`) already accepts either
`string` or `number` for both and coerces via `String()`, so this caused
no incident — it was caught only because a real webhook was captured and
compared, not because anything broke. Worth remembering: Kora's docs and
even a real *verify* call are not a substitute for observing the real
*webhook* payload directly when the two diverge.

This differs from withdrawals (Phase 4), where Kora's payout API does
return a distinct provider-side reference — so this deviation is specific
to the funding/charge flow, not a correction to the schema or column
itself.

## Decision

For `transactions` of `type = 'funding'`, `provider_reference` is set to the
same value as `reference` at transaction creation, rather than left to be
populated later from a Kora-supplied ID. Webhook idempotency and
self-verify polling (docs/architecture.md §4.2, §4.4) both dedupe/correlate
by matching the webhook's/verify response's `data.reference` back to
`transactions.reference` directly — `provider_reference` is not what's
actually queried for correlation on this transaction type, but it stays
populated so:

- the column has a consistent meaning across all transaction types (never
  null for a provider-backed transaction), rather than being populated for
  withdrawals but not funding
- any future tooling/reporting that queries by `provider_reference` doesn't
  need a special case for funding rows

## Alternatives considered

- **Leave `provider_reference` null for funding transactions.** Rejected —
  breaks the "indexed, used to correlate webhooks" invariant §5 states for
  the column, and would require every future dashboard/reconciliation query
  to special-case funding vs. withdrawal rows.
- **Extract and store the `KPY-PI-...` token from the `checkout_url` path as
  `provider_reference`.** Rejected — it's an undocumented implementation
  detail of the checkout URL's path structure, not a field Kora's API
  contract actually returns or guarantees; brittle to depend on for
  anything beyond human-facing the URL itself, and it still isn't returned
  in the webhook payload, so it couldn't be used for webhook correlation
  anyway.

## Consequences

- `KoraAdapter.initiatePayment()` doesn't need to parse anything out of the
  checkout URL — it only needs to return the URL itself and the reference
  we already generated.
- If Kora's charge API is ever found to return a genuine distinct
  transaction ID in some other endpoint or webhook variant not exercised by
  this sandbox test, `provider_reference` can start being set from that
  value instead — no schema change, since the column already exists and is
  populated; only the value it's populated with would change.
- The contract test suite (`test/contract/`) should assert the shape
  documented here (no distinct ID in the charge-verify response) so a
  future Kora API change that *adds* one is caught rather than silently
  assumed away.
