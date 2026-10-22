import { INestApplication } from '@nestjs/common';
import { json, Request } from 'express';

// Up to 9 base64 JPEGs at 1,000,000 characters each, plus slack.
const LIVENESS_CAPTURE_BODY_LIMIT = '10mb';
const LIVENESS_CAPTURE_ROUTES = /^(\/v\d+)?\/kyc\/verify-(bvn|nin)\/?$/;

export function setupBodyParsers(app: INestApplication): void {
  // Registered first so it parses (and marks as parsed) these routes' bodies
  // before the global 1mb parser below can reject them. No rawBody here, so
  // the selfie isn't copied and kept on the request.
  app.use(
    LIVENESS_CAPTURE_ROUTES,
    json({ limit: LIVENESS_CAPTURE_BODY_LIMIT }),
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
