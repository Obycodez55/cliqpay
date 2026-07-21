import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: { userId: string; sessionId: string };
}

interface AccessTokenClaims {
  sub: string;
  sid: string;
}

// First protected route in the app (issue #4's TOTP enroll/confirm) — reuses
// the JwtService already registered by AuthModule for signing access tokens
// rather than pulling in @nestjs/passport for a single verify call.
//
// Lives in its own guards/ folder, not internal/ — a guard doesn't need
// internal/'s hiding trick (see mfa.service.ts's own note): the
// boundaries/entry-point allow-list only matches `*.service.ts`/`*.module.ts`
// at a module's root, so a file named `*.guard.ts` is never a valid
// cross-module entry point regardless of which folder it sits in.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const claims =
        await this.jwtService.verifyAsync<AccessTokenClaims>(token);
      (request as AuthenticatedRequest).user = {
        userId: claims.sub,
        sessionId: claims.sid,
      };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
