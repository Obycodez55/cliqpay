# Contract tests

Confirms the real provider adapters still match what the recorded fixtures and the fakes assume, by running against each provider's real sandbox — see `docs/architecture.md` §10. Specs are named `*.contract-spec.ts` and run via `pnpm test:contract` — nightly/pre-release cadence, not per-commit, since they hit a real network sandbox.

## Prembly (`prembly.contract-spec.ts`)

Skipped unless `PREMBLY_SECRET_KEY` is set; use a sandbox key. It calls the BVN and NIN lookups and asserts the response shapes (keys and value types) against `test/fixtures/prembly/`, and runs `PremblyKycProvider` against the sandbox. Each lookup is a free sandbox call.

The sandbox returns one canned success for every well-formed request, so it cannot exercise failure paths: not found (`01`), blocked BVN (`07`), service unavailable (`02`), empty wallet (`03`) and rate limiting (429) are only covered by the synthetic fixtures in `test/fixtures/prembly/synthetic/`, which are built from the docs and must be re-confirmed by hand against the live service.

`KoraAdapter` has no contract spec yet. The refund contract spec (issue #62) will assert the refund initiate, status and error shapes against `test/fixtures/kora-refunds/` (recorded in `docs/research/kora-refunds.md`) using its own bank-transfer sandbox charge, so it needs no manual step.
