import { INestApplication } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';

// A worker that picks up a job-scheduler job re-registers the scheduler's
// next iteration before running the job. If the worker's connection is closed
// while that call is in flight, BullMQ's retry loop skips its back-off once
// `closing` is set and retries "Connection is closed" forever: a microtask
// spin that pins the CPU and starves timers, so not even Jest's test timeout
// fires. `close(true)` and `pause(true)` both leave that call running, and a
// worker already paused with `true` turns the `pause()` below into a no-op, so
// contexts must pause with a plain `pause()`. `pause()` waits for the main
// loop, and with it the upsert, to finish; force-closing is safe after that.
// Workers are discovered rather than listed so a new processor can't be left
// out.
export async function closeBullmqWorkers(app: INestApplication): Promise<void> {
  const hosts = app
    .get(DiscoveryService)
    .getProviders()
    .map((wrapper) => wrapper.instance as unknown)
    .filter(
      (instance): instance is WorkerHost => instance instanceof WorkerHost,
    );
  await Promise.all(
    hosts.map(async (host) => {
      await host.worker.waitUntilReady();
      await host.worker.pause();
      await host.worker.close(true);
    }),
  );
}
