import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

// Shared Redis connection for caching. BullMQ (shared/events) manages its
// own dedicated connection instead of reusing this one — see the comment
// in event-bus.module.ts for why.
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Redis(config.redis.url),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
