import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { json, NextFunction, Request, RequestHandler, Response } from 'express';

// 9 base64 JPEGs (selfie plus up to 8 frames) at 1,000,000 characters each,
// plus JSON overhead.
const LIVENESS_CAPTURE_BODY_LIMIT_BYTES = 9 * 1_000_000 + 10_000;
const LIVENESS_CAPTURE_ROUTES = /^(\/v\d+)?\/kyc\/verify-(bvn|nin)\/?$/;

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

// Parsing runs before the route's guard, so the larger limit is only granted
// to a request carrying a validly signed token; everyone else falls through to
// the global 1mb parser.
function largeBodyForAuthenticated(jwtService: JwtService): RequestHandler {
  const parse = json({ limit: LIVENESS_CAPTURE_BODY_LIMIT_BYTES });
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) {
      next();
      return;
    }
    jwtService.verifyAsync(token).then(
      () => parse(req, res, next),
      () => next(),
    );
  };
}

export function setupBodyParsers(app: INestApplication): void {
  // Registered first so it parses (and marks as parsed) these routes' bodies
  // before the global 1mb parser below can reject them. No rawBody here, so
  // the selfie isn't copied and kept on the request.
  app.use(
    LIVENESS_CAPTURE_ROUTES,
    largeBodyForAuthenticated(app.get(JwtService, { strict: false })),
  );
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
}
