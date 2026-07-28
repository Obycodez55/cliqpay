import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { Response } from 'express';
import { AppConfig } from '../config';

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
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);

  app.use('/doc', (_req: unknown, res: Response) => res.json(document));

  app.use(
    '/reference',
    apiReference({
      content: document,
      theme: 'purple',
      hideClientButton: config.app.env === 'production',
    }),
  );
}
