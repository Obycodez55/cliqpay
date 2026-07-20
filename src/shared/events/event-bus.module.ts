import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import {
  BULLMQ_REDIS_CONNECTION,
  BullmqConnectionModule,
} from './bullmq-connection.module';
import { DOMAIN_EVENTS_QUEUE, EventBusService } from './event-bus.service';

@Module({
  imports: [
    BullmqConnectionModule,
    BullModule.forRootAsync({
      imports: [BullmqConnectionModule],
      inject: [BULLMQ_REDIS_CONNECTION],
      useFactory: (connection: Redis) => ({ connection }),
    }),
    BullModule.registerQueue({ name: DOMAIN_EVENTS_QUEUE }),
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
