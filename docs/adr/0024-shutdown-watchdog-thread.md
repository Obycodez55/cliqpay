# ADR-0024: Worker-thread watchdog as the shutdown backstop

**Status:** accepted
**Date:** 2026-11-04

## Context

`main.ts` arms a 10-second `setTimeout` that logs and calls `process.exit(1)` if graceful shutdown stalls. That timer runs on the main thread's event loop, so it cannot fire while the loop is starved. A loop of `await Promise.resolve()` (the shape of BullMQ's retry of a scheduler upsert on a closed connection, found in #49 and #57) starves timers indefinitely: in a throwaway reproduction the timer never fired and the process spun until it was killed externally. Any such spin during shutdown pins a CPU and hangs the process until the orchestrator SIGKILLs it.

## Decision

Keep the in-process timer and add a watchdog on a separate thread.

1. `armShutdownWatchdog(graceMs)` (`src/common/shutdown-watchdog.ts`) starts a `worker_threads` Worker that sleeps for the grace period plus a 500 ms margin and then runs `process.kill(process.pid, 'SIGKILL')`. A worker has its own event loop, so a main-thread spin does not stop it.
2. `main.ts` arms it at the same moment as the force-exit timer and cancels it wherever that timer is cleared. The worker is `unref`'d and terminated on cancel, so it never keeps a clean exit waiting.
3. The margin keeps the watchdog behind the timer: when the loop still yields, the timer fires first, logs "forcing exit" and exits 1; the watchdog only acts when the timer could not.
4. The orchestrator's termination grace period should be at least 15 seconds, so the platform does not SIGKILL the process before these in-process backstops have had their chance. That value is a deployment setting and is not verifiable from this repo, which has no deploy configuration.

## Alternatives considered

- **Platform-only (document the termination grace period).** Cheapest, but unverifiable here and leaves a CPU-pinned process running until the orchestrator acts. Kept as guidance, not as the mechanism.
- **Watchdog only, drop the timer.** Loses the "forcing exit" log line and the exit code 1 for the common case where the loop is still responsive.
- **Child-process or external supervisor.** More moving parts than a thread for the same effect.

## Consequences

- A starved shutdown ends in SIGKILL (exit 137) after about 10.5 seconds, with no log line, since a logger call on the starved thread would not run either.
- SIGKILL skips any remaining cleanup; by then graceful shutdown has already failed to complete.
- The behaviour is covered by tests that spawn child processes and assert on exit signal and timing.
