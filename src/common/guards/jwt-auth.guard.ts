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

// Cross-cutting infra, not auth-internal — users and ledger both guard
// routes with this too (profile, wallet balance), so it lives in
// common/guards/ rather than inside the auth module. Verifies the JWT
// itself (via JwtService) rather than looking anything up, so it has no
// dependency on auth/users beyond the token's own claims. Any module that
// uses it must import JwtModule itself (see auth/users/ledger modules) —
// this file registers no providers of its own.
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
