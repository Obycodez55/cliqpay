# Contract tests

Confirms the real provider adapters still match what the recorded fixtures and the fakes assume, by running against each provider's real sandbox — see `docs/architecture.md` §10. Specs are named `*.contract-spec.ts` and run via `pnpm test:contract` — nightly/pre-release cadence, not per-commit, since they hit a real network sandbox.

## Prembly (`prembly.contract-spec.ts`)

Skipped unless `PREMBLY_SECRET_KEY` is set; use a sandbox key. It calls the BVN and NIN lookups and asserts the response shapes (keys and value types) against `test/fixtures/prembly/`, and runs `PremblyKycProvider` against the sandbox. Each lookup is a free sandbox call.

The sandbox returns one canned success for every well-formed request, so it cannot exercise failure paths: not found (`01`), blocked BVN (`07`), service unavailable (`02`), empty wallet (`03`) and rate limiting (429) are only covered by the synthetic fixtures in `test/fixtures/prembly/synthetic/`, which are built from the docs and must be re-confirmed by hand against the live service.

## Kora refunds (`kora-refunds.contract-spec.ts`)

Skipped unless `KORA_SECRET_KEY` is set to a test key (`sk_test_...`; Kora's sandbox and live share a host, so a live key never runs it). It creates its own bank-transfer sandbox charge, which settles by itself in about 30 seconds (no checkout page, no card data), refunds the principal through `KoraAdapter.initiateRefund`, and asserts the recorded shapes from `test/fixtures/kora-refunds/` (`docs/research/kora-refunds.md`): the accepted and status responses, the unknown-payment error, `already_exists` for a repeated reference, `not_found` for an unknown refund, and the HMAC-over-`data` webhook signature scheme. It takes about 2 minutes because Kora answers a second attempt on the same payment with a 429 for about a minute before it checks the reference. Each run makes about 8 sandbox calls.

The `processing` window and real failures cannot be produced in the sandbox, so those mappings are covered by the recorded fixtures only.

`KoraAdapter` has no other contract spec yet.
