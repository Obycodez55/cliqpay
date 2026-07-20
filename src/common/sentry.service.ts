import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { APP_CONFIG, AppConfig } from '../config';

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
