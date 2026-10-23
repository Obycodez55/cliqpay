import {
  BeforeApplicationShutdown,
  Inject,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { BullModule, WorkerHost } from '@nestjs/bullmq';
import Redis from 'ioredis';
import {
  BULLMQ_REDIS_CONNECTION,
  BullmqConnectionModule,
} from './bullmq-connection.module';
import {
  DOMAIN_EVENTS_QUEUE,
  EventBusService,
  PRIORITY_DISPATCH_QUEUE,
} from './event-bus.service';

// The getter throws until the worker exists, which a signal during boot beats.
function initialisedWorker(host: WorkerHost): WorkerHost['worker'] | null {
  try {
    return host.worker;
  } catch {
    return null;
  }
}

@Module({
  imports: [
    BullmqConnectionModule,
    DiscoveryModule,
    BullModule.forRootAsync({
      imports: [BullmqConnectionModule],
      inject: [BULLMQ_REDIS_CONNECTION],
      useFactory: (connection: Redis) => ({ connection }),
    }),

    BullModule.registerQueue({
      name: DOMAIN_EVENTS_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    }),
    // Awaited callers set their own timeout, so total job time needs to fit
    // inside whatever that is — retries here are few and fast rather than
    // the queue above's slower backoff. See EventBusService.dispatchAndAwait.
    BullModule.registerQueue({
      name: PRIORITY_DISPATCH_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 300 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    }),
  ],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventBusModule
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(
    @Inject(BULLMQ_REDIS_CONNECTION) private readonly connection: Redis,
    private readonly discovery: DiscoveryService,
  ) {}

  // A worker re-registers its job scheduler's next iteration before running a
  // scheduler job. If its connection is closed mid-call, BullMQ retries
  // "Connection is closed" in a microtask loop that never yields, so the
  // process pins the CPU and even the force-exit timer in main.ts can't fire.
  // A waiting pause() lets that call finish; only then is closing safe.
  async beforeApplicationShutdown(): Promise<void> {
    const hosts = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(
        (instance): instance is WorkerHost => instance instanceof WorkerHost,
      );
    await Promise.all(
      hosts.map(async (host) => {
        const worker = initialisedWorker(host);
        if (!worker) {
          return;
        }
        await worker.waitUntilReady();
        await worker.pause();
        await worker.close();
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit();
  }
}
