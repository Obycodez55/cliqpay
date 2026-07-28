import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { Response } from 'express';
import { AppConfig } from '../config';

const SCALAR_STANDALONE_BUNDLE_PATH = join(
  process.cwd(),
  'node_modules/@scalar/api-reference/dist/browser/standalone.js',
);
const SCALAR_ASSET_PATH = '/reference-assets/standalone.js';

// /doc and /reference are intentionally public in every environment right
// now — there's no staff/admin auth system in this app yet to gate them
// behind (see docs/architecture.md, admin auth section), and building one
// just for this would be its own feature. Revisit once that need is real.
export function setupApiDocs(app: INestApplication, config: AppConfig): void {
  const documentConfig = new DocumentBuilder()
    .setTitle('Cliqpay API')
    .setDescription('Cliqpay peer-to-peer wallet platform API')
    .setVersion('1')
    .addBearerAuth()
    .addTag('Application', 'Liveness and health checks')
    .addTag(
      'Authentication',
      'Registration, login, sessions, and account recovery',
    )
    .addTag('MFA', 'Multi-factor authentication enrollment and verification')
    .addTag('Profile', "The current user's profile")
    .addTag('Wallet', "The current user's wallet balance")
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);

  // Scalar/Redoc-style sidebar grouping (x-tagGroups). Once this key is
  // present it's exhaustive — any tag not listed in a group disappears
  // from the sidebar entirely, so every tag needs a home here. Each group
  // name is deliberately never identical to its only child tag (that's
  // what produced the repeated "Profile > Profile" look before) — Account
  // bundles Profile+Wallet as the user's own data, System covers
  // liveness/health, and Authentication is the one group that legitimately
  // shares a name with a child, since it has two: general auth flows plus
  // the MFA step nested under it.
  (document as { 'x-tagGroups'?: unknown })['x-tagGroups'] = [
    { name: 'Authentication', tags: ['Authentication', 'MFA'] },
    { name: 'Account', tags: ['Profile', 'Wallet'] },
    { name: 'System', tags: ['Application'] },
  ];

  app.use('/doc', (_req: unknown, res: Response) => res.json(document));

  // apiReference()'s default `cdn` points at jsdelivr — fine on an open
  // network, but a dead end behind a corporate firewall or in an offline
  // dev environment (the reference page silently renders blank, no error).
  // Serving the same bundle @scalar/api-reference already ships locally
  // removes that dependency entirely.
  if (!existsSync(SCALAR_STANDALONE_BUNDLE_PATH)) {
    throw new Error(
      `Scalar standalone bundle not found at ${SCALAR_STANDALONE_BUNDLE_PATH} — is @scalar/api-reference installed?`,
    );
  }
  const scalarBundle = readFileSync(SCALAR_STANDALONE_BUNDLE_PATH);
  app.use(SCALAR_ASSET_PATH, (_req: unknown, res: Response) =>
    res.type('application/javascript').send(scalarBundle),
  );

  // helmet()'s default CSP (script-src 'self', no inline) blocks the inline
  // <script> Scalar's own HTML uses to call Scalar.createApiReference() —
  // it fails silently (no thrown error, no visible console message), the
  // page just renders blank. Scoped to this one route only; every real API
  // endpoint keeps the strict default.
  app.use('/reference', (_req: unknown, res: Response, next: () => void) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https: data:",
    );
    next();
  });

  app.use(
    '/reference',
    apiReference({
      content: document,
      cdn: SCALAR_ASSET_PATH,
      theme: 'purple',
      hideClientButton: config.app.env === 'production',
    }),
  );
}
