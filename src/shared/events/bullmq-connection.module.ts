import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../config';

export const BULLMQ_REDIS_CONNECTION = Symbol('BULLMQ_REDIS_CONNECTION');

// Split out so the same connection instance can be handed to
// BullModule.forRootAsync *and* held here for a clean shutdown — BullMQ
// never closes a connection it didn't create itself, so something has to.
@Module({
  providers: [
    {
      provide: BULLMQ_REDIS_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis(config.redis.url, { maxRetriesPerRequest: null }),
    },
  ],
  exports: [BULLMQ_REDIS_CONNECTION],
})
export class BullmqConnectionModule {}
