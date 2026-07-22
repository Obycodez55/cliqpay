import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config';
import { REDIS_CLIENT, RedisModule } from '../redis/redis.module';

// Global default. Auth, payment-initiation, and KYC endpoints need stricter
// route-level overrides on top of this — see docs/architecture.md §7 Security
// — apply those with @Throttle({ default: { ttl, limit } }) once those
// controllers exist, they don't replace this global floor.
//
// Storage is Redis-backed (the shared cache connection from RedisModule) so
// the limit is enforced across all app instances, not per-process.
@Module({
  imports: [
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [APP_CONFIG, REDIS_CLIENT],
      useFactory: (config: AppConfig, redis: Redis) => ({
        throttlers: [
          {
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.limit,
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
