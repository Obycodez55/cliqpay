import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { APP_CONFIG, AppConfig } from '../config';

// Request bodies carry BVNs, passwords and liveness images; none belong in an event.
export function stripRequestBody<T extends { request?: { data?: unknown } }>(
  event: T,
): T {
  if (event.request) {
    delete event.request.data;
  }
  return event;
}

@Injectable()
export class SentryService implements OnModuleInit {
  private enabled = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit() {
    const dsn = this.config.sentry.dsn;
    if (!dsn) {
      return;
    }

    Sentry.init({
      dsn,
      environment: this.config.app.env,
      beforeSend: stripRequestBody,
    });
    this.enabled = true;
  }

  captureException(exception: unknown): void {
    if (!this.enabled) {
      return;
    }
    Sentry.captureException(exception);
  }
}
