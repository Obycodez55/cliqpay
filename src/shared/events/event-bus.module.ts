import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
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

@Module({
  imports: [
    BullmqConnectionModule,
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
export class EventBusModule implements OnApplicationShutdown {
  constructor(
    @Inject(BULLMQ_REDIS_CONNECTION) private readonly connection: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit();
  }
}
