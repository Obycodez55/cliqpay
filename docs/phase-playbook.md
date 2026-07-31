# Phase implementation playbook

How Phase 1 (auth/identity/wallet) actually got built, distilled into a repeatable process for the phases after it. This is a workflow doc, not a design doc — for what to build, see `docs/architecture.md`; for decisions already made, see `docs/adr/`.

## 1. Design the phase before writing an issue

Read the relevant section(s) of `docs/architecture.md`, then stress-test the design before it becomes issues — session mechanics, edge cases, exact numbers (cooldowns, expiry windows, retry counts). Use `/grill-me` for this: it surfaces the questions a design review would ask, one at a time, and each answer either becomes a concrete spec detail or an ADR.

**Take note of:** don't let "the architecture doc already covers this" substitute for actually deciding the numbers. §6 says the doc is a design reference, not a build order — it documents the target shape, not the specific values a real implementation needs (is the OTP 4 digits or 6? does resend cooldown apply per-purpose or globally?). Those get decided at this stage, not discovered mid-implementation.

## 2. Break the design into vertical-slice issues

Use `/to-issues` to turn the grilled design into GitHub issues. Insist on vertical slices (a whole flow: register end-to-end, login end-to-end) over horizontal layers (all entities, then all services, then all controllers) — a vertical slice is independently reviewable and shippable; a layer isn't.

**Take note of:** confirm the breakdown with the user before publishing the issues. Cheap to fix at this stage, expensive once three issues have already been implemented against a boundary that turns out wrong.

## 3. Implement one issue at a time, in a separate session

For each issue: use `spawn_task` (not the `Agent` tool) to hand it to its own session. `spawn_task` produces a chip the user clicks to actually start the session — it's for delegating real implementation work the user wants to review as a distinct unit, not for research or sub-queries the Agent tool already covers.

Once a task reports back, review the diff rigorously — read the actual code, not just the session's summary of what it did — before merging. Once that review is complete and the user has approved it, close the corresponding GitHub issue with a short comment noting what shipped (and any fixes made during review) — an approved issue shouldn't sit open. Move to the next issue only after the current one is merged.

**Take note of:**
- Never commit without the user reviewing the diff first, every time — not just once per session (see `CLAUDE.md`). If you find yourself running `git add` in anticipation of a commit that hasn't been explicitly greenlit yet, stop and unstage.
- A session's own summary of its changes is not verification. Read the diff.
- Closing the issue is not the same as committing — it's tracked-work bookkeeping, not a code change, and follows once the user has actually approved the review (don't close preemptively while fixes are still pending).

## 4. Watch for architectural smells mid-phase — don't push through them

Somewhere in the middle of Phase 1, issue #8's review surfaced that profile and wallet concerns had been crammed into `auth`, which was already core-vs-peripheral load-bearing and about to get worse. The response was not to patch around it and keep going:

1. Name the smell precisely (what's overloaded, why it'll get worse, not just "this feels off").
2. Think through multiple real solutions, not just the first one — including *why* each one is or isn't a good fit for this codebase's actual constraints (e.g. "if we're giving auth its own credentials table for cleanliness, how many auth operations can actually work without reaching into the user domain?" was the question that decided the users/auth split shape).
3. Write the decision as an ADR (see `docs/adr/0005-users-auth-split.md` for the shape this took) — the reasoning is what future-you needs, not just the conclusion.
4. Fold the refactor into whichever in-flight session's work it's layered on top of, with an explicit brief of what's changing and why, rather than starting a disconnected cleanup pass.

**Take note of:** a smell caught mid-phase and fixed with a real design pass is cheap. The same smell found in the end-of-phase audit (step 5) is a full refactor plus everything built on top of it since. Don't defer a real architectural concern because "we're close to done."

## 5. Run an independent, fresh-eyes audit at the end of the phase

Once every issue in the phase is merged, review the phase as a whole — not issue-by-issue — via `spawn_task`, explicitly asking for a critical audit rather than a summary. A fresh session with no investment in the code written catches things the implementing sessions (and the reviewing you) got used to.

**Take note of:** treat every finding as needing independent verification, not just relay — re-check each one against the actual code before deciding what to fix. A plausible-sounding finding that doesn't hold up wastes a fix cycle; a real one that gets waved through because "the audit already said so" is worse.

## 6. Fix real findings directly, ranked by severity

Critical findings (security gaps, correctness bugs) get fixed first, hands-on, with test coverage added for the specific gap. Don't batch a Critical fix behind a discussion of a separate open design question — fix, verify, merge, then come back to the design conversation.

## 7. Do a housekeeping pass before calling the phase done

Two categories of debt tend to accumulate silently across a many-issue phase and are worth checking for explicitly, with real numbers rather than a gut feeling:

- **Comment noise.** Count comments that just restate the code or point at an issue/ADR/doc-section instead of stating the *why* inline. If a comment's only content is "see issue #N" or "per ADR-000X", either inline the actual one-sentence reason or delete it — a reader shouldn't have to open another document to find out why a line exists. This isn't only about bad comments — it's about volume: if most methods in a reviewed file have one, that's the bar set too low, not unusually subtle code. Delete on sight any comment whose reasoning a reader wouldn't miss.
- **Integration test file size.** A single spec file that grows one `describe` block per issue becomes unreviewable and slow to run as a unit. Split by feature area (not by line count) once a file covers several unrelated flows, with the expensive setup (app bootstrap, Testcontainers, shared request helpers) factored into a shared test-support module the split files import — never duplicated per file.
- **Documentation drift.** Check whether real decisions made during the phase — a schema shape, a module boundary, a naming convention discovered/settled mid-implementation — actually landed in `docs/` (architecture.md, conventions.md, an ADR) rather than living only in a code comment, a closed issue's body, or this session's own memory. A decision that only exists in a merged PR is invisible to the next phase's design pass.

Verify a split preserves every test (run the full suite before and after, compare counts — don't just count `it()` blocks in the diff) before merging it.

**Take note of:** splitting a Testcontainers-backed suite into more files means more container startups, which is a real (if usually small) increase in flakiness surface from Docker VM resource contention — not a logic regression. If post-split flakiness shows up, isolate the failing files and re-run them alone before assuming the split introduced a bug; don't "fix" it by serializing the whole suite (`maxWorkers: 1`) without first confirming that actually helps — it can make things worse under sustained multi-container load.

## 8. Run `/e2e-test-local` against a genuinely fresh environment

Before considering the phase done, run every scenario as a real client would — actual HTTP requests against the running dev server, not calling services directly. This is what catches environment-shaped gaps automated tests don't exercise (see below).

**Take note of:**
- Prefer fake providers (email/SMS/push) for this pass unless real credentials are already working — don't block the whole e2e run on getting a third-party sandbox configured. Disclose the skip explicitly in the report; don't let it read as "delivery confirmed" when it wasn't.
- A local environment mismatch CI never hits is a legitimate finding, not a distraction from the "real" testing. Phase 1 surfaced that local Postgres 14 can't run a migration using `NULLS NOT DISTINCT` (needs 15+) — something Testcontainers-based CI never caught because it pins a modern Postgres image. Document gaps like this (a README prerequisites note) so the next environment doesn't lose the same time.
- If test setup requires destroying and recreating a test account mid-run (e.g. a lost password), that's fine — this data is disposable — but don't fabricate state via direct DB writes to skip a step; only reset state that's already been proven once via a real request (e.g. clearing a lockout counter after the lockout itself was already confirmed via real failed-login requests).
- Produce the final report as a published artifact: one line per scenario (pass/fail), a findings section with actual request/response evidence for anything unexpected, and an explicit list of anything skipped and why.

## Summary checklist

1. `/grill-me` the phase design against `docs/architecture.md` → pin down concrete numbers, write ADRs for real decisions.
2. `/to-issues` → vertical slices, confirm the breakdown before publishing.
3. Per issue: `spawn_task` → review the actual diff → merge → close the issue once approved → next issue. Never commit without the user's explicit go-ahead on that diff.
4. Mid-phase architectural smell? Stop, think through real alternatives, ADR the decision, fold the refactor into in-flight work.
5. End of phase: independent fresh-eyes audit via `spawn_task`, verify every finding yourself.
6. Fix real findings, Critical first, with test coverage.
7. Housekeeping pass: comment noise, test file size, documentation drift — with real before/after numbers.
8. `/e2e-test-local` against a fresh environment, fake providers unless real ones already work, report as an artifact with explicit skips and environment findings called out.
