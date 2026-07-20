import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config';

// Global default. Auth, payment-initiation, and KYC endpoints need stricter
// route-level overrides on top of this — see docs/architecture.md §7 Security
// — apply those with @Throttle({ default: { ttl, limit } }) once those
// controllers exist, they don't replace this global floor.
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.limit,
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
