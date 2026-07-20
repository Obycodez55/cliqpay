# Contract tests

Confirms `KoraAdapter` / `KoraSandboxKycProvider` still match what `FakeAdapter` / `FakeKycProvider` assume, by running against Kora's real sandbox — see `docs/architecture.md` §10.

Empty until `PaymentProviderAdapter` (Phase 2) or `KycProvider` (Phase 6) exist; there's nothing to contract-test against yet. Specs go here named `*.contract-spec.ts` and run via `pnpm test:contract` — nightly/pre-release cadence, not per-commit, since they hit a real network sandbox.
