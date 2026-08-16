import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import { AuthenticatedRequest } from './jwt-auth.guard';

// Deliberately not a ThrottlerGuard subclass: that class reads its limit
// from the same @Throttle() metadata the global IP-keyed guard (see
// rate-limit.module.ts) also reads, so overriding it on a route would
// tighten the IP-keyed guard too, defeating per-user isolation (two users
// behind one IP would still share a bucket). This talks to the same
// Redis-backed ThrottlerStorage directly instead, under its own key, so it
// enforces independently. ThrottlerStorage is resolved lazily via
// ModuleRef rather than constructor injection — the users module is
// imported by several test contexts that never wire up RateLimitModule
// (no need for Redis in those slices), and constructor injection would
// fail Nest's DI graph for all of them even though they never call this
// route. A factory (mirroring Nest's own @Throttle-less-guard pattern)
// rather than one fixed class, so future authenticated endpoints can reuse
// the same per-user tracking with their own limit.
export function PerUserThrottlerGuard(
  limit: number,
  ttlMs: number,
): Type<CanActivate> {
  @Injectable()
  class PerUserThrottlerGuardImpl implements CanActivate {
    constructor(private readonly moduleRef: ModuleRef) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const storage = this.moduleRef.get<ThrottlerStorage>(ThrottlerStorage, {
        strict: false,
      });
      const req = context
        .switchToHttp()
        .getRequest<Partial<AuthenticatedRequest>>();
      const tracker = req.user?.userId ?? req.ip ?? 'unknown';
      const key = `per-user:${context.getClass().name}:${context.getHandler().name}:${tracker}`;

      const { totalHits, isBlocked } = await storage.increment(
        key,
        ttlMs,
        limit,
        ttlMs,
        'per-user',
      );
      if (isBlocked || totalHits > limit) {
        throw new ThrottlerException();
      }
      return true;
    }
  }

  return PerUserThrottlerGuardImpl;
}
