import { WorkerHost } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import Redis from 'ioredis';
import { EventBusModule } from '../event-bus.module';

interface FakeWorker {
  waitUntilReady: jest.Mock<Promise<void>, []>;
  pause: jest.Mock<Promise<void>, []>;
  close: jest.Mock<Promise<void>, []>;
}

function workerHost(
  calls: string[],
  name: string,
  pause?: () => Promise<void>,
) {
  const worker: FakeWorker = {
    waitUntilReady: jest.fn(() => {
      calls.push(`${name}:ready`);
      return Promise.resolve();
    }),
    pause: jest.fn(async () => {
      await pause?.();
      calls.push(`${name}:pause`);
    }),
    close: jest.fn(() => {
      calls.push(`${name}:close`);
      return Promise.resolve();
    }),
  };
  const host = Object.create(WorkerHost.prototype) as WorkerHost;
  (host as unknown as { _worker: FakeWorker })._worker = worker;
  return { host, worker };
}

function moduleWith(instances: unknown[]) {
  const quit = jest.fn();
  const connection = { quit } as unknown as Redis;
  const discovery = {
    getProviders: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
  return {
    module: new EventBusModule(connection, discovery),
    quit,
  };
}

describe('EventBusModule shutdown', () => {
  it('waits for each worker, pauses it, then closes it, without touching the connection', async () => {
    const calls: string[] = [];
    const a = workerHost(calls, 'a');
    const b = workerHost(calls, 'b');
    const { module, quit } = moduleWith([a.host, {}, null, b.host]);

    await module.beforeApplicationShutdown();

    for (const name of ['a', 'b']) {
      expect(calls.indexOf(`${name}:ready`)).toBeLessThan(
        calls.indexOf(`${name}:pause`),
      );
      expect(calls.indexOf(`${name}:pause`)).toBeLessThan(
        calls.indexOf(`${name}:close`),
      );
    }
    expect(quit).not.toHaveBeenCalled();
  });

  it('does not close a worker while its pause is still waiting for the job in flight', async () => {
    const calls: string[] = [];
    let finishJob!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    const slow = workerHost(calls, 'slow', () => inFlight);
    const { module } = moduleWith([slow.host]);

    const shutdown = module.beforeApplicationShutdown();
    await new Promise((resolve) => setImmediate(resolve));

    expect(slow.worker.pause).toHaveBeenCalledTimes(1);
    expect(slow.worker.close).not.toHaveBeenCalled();

    finishJob();
    await shutdown;

    expect(slow.worker.close).toHaveBeenCalledTimes(1);
  });

  it('skips a worker that was never created and still closes the others', async () => {
    const calls: string[] = [];
    const never = Object.create(WorkerHost.prototype) as WorkerHost;
    const ready = workerHost(calls, 'ready');
    const { module } = moduleWith([never, ready.host]);

    await expect(module.beforeApplicationShutdown()).resolves.toBeUndefined();

    expect(ready.worker.close).toHaveBeenCalledTimes(1);
  });

  it('quits the shared connection on application shutdown', async () => {
    const { module, quit } = moduleWith([]);

    await module.onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
