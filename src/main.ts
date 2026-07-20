import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const FORCE_EXIT_TIMEOUT_MS = 10_000;

// app.enableShutdownHooks() would do this generically, but managing the
// signals ourselves gets us shutdown logging and a forced-exit safety net
// if something (a stuck connection) hangs app.close() indefinitely.
function setupGracefulShutdown(app: INestApplication, logger: Logger) {
  let shuttingDown = false;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.log(`${signal} received, shutting down gracefully`);

      const forceExitTimer = setTimeout(() => {
        logger.error(
          `Graceful shutdown did not complete within ${FORCE_EXIT_TIMEOUT_MS}ms, forcing exit`,
        );
        process.exit(1);
      }, FORCE_EXIT_TIMEOUT_MS);
      forceExitTimer.unref();

      app
        .close()
        .then(() => {
          logger.log('Shutdown complete');
          clearTimeout(forceExitTimer);
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, 'Error during graceful shutdown');
          clearTimeout(forceExitTimer);
          process.exit(1);
        });
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  setupGracefulShutdown(app, logger);
  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ limit: '1mb', extended: true }));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableCors({
    // Empty allowlist (default in dev) reflects no origin restriction is
    // configured yet — set CORS_ALLOWED_ORIGINS before any browser client
    // (admin panel, mobile web) exists. See docs/conventions.md.
    origin:
      config.app.corsAllowedOrigins.length > 0
        ? config.app.corsAllowedOrigins
        : true,
    credentials: true,
  });

  await app.listen(config.app.port);
}
void bootstrap();
