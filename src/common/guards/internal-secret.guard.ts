import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config';

// Cross-cutting infra, not disputes-internal — mirrors JwtAuthGuard's own
// reasoning (common/guards/jwt-auth.guard.ts): any future internal/ops
// endpoint reuses this rather than each module inventing its own shared-
// secret check. No AdminUser model exists yet (docs/architecture.md §9), so
// this is the interim trust boundary for admin-triggered actions — see
// docs/adr/0016-disputes-module-boundary.md.
@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-secret'];
    if (typeof provided !== 'string') {
      throw new UnauthorizedException();
    }

    const expected = this.config.internal.apiSecret;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch rather than returning
    // false — checked first so an attacker can't distinguish "wrong length"
    // from "wrong secret" via a thrown-vs-returned code path, and so the
    // length check itself doesn't become a side channel it needs to protect.
    const matches =
      providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer);
    if (!matches) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
