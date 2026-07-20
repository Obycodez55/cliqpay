# ADR-0001: Record architecture decisions as ADRs

**Status:** accepted
**Date:** 2026-07-20

## Context

`docs/architecture.md` already captures the major decisions made before any code existed — Kora as the payment provider, modular monolith over microservices, integer minor units for money, provider-agnostic schema, the four-layer testing strategy, and others. That document is a living design doc: it gets edited in place as understanding changes. Once code exists, some decisions will need to be revisited or reversed (e.g. adding a second payment provider, changing the KYC tier model), and a living doc that gets edited in place loses the *why* behind the choice that came before.

## Decision

Use lightweight ADRs (this format, adapted from Michael Nygard's) for decisions made *after* this point — new ones, reversals, or anything that changes something `architecture.md` already committed to. `architecture.md` stays the reference for current-state design; ADRs record the decision trail. Use [template.md](template.md) as the starting point for each one, numbered sequentially.

The decisions already locked in as of v7 of the architecture doc are not being retroactively split into individual ADRs — that doc's own version history already serves as the record for how they evolved (v2 → v7 changelog notes at the top of the file).

## Alternatives considered

- **Retroactively write ADRs for every existing decision** — rejected; the architecture doc's version notes already capture that history, and duplicating it fragments the design into two places that can drift.
- **Keep editing architecture.md only, no ADRs** — rejected; once code and real constraints exist, in-place edits lose the record of what was tried and rejected, which matters more as the system's surface area grows.

## Consequences

Every future non-trivial architectural change gets a short paper trail explaining why, without needing to restructure the whole architecture doc each time. Adds a small amount of process — one file per meaningful decision — starting now.
