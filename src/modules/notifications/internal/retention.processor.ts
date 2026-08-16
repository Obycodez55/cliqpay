import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../../../config';
import { NotificationService } from '../notification.service';

export const NOTIFICATION_RETENTION_QUEUE = 'notification-retention';
const RETENTION_JOB_NAME = 'delete-expired-notifications';
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes in-app notification rows older than
 * `NOTIFICATION_RETENTION_DAYS` regardless of read state — shipped with the
 * channel itself, not deferred (docs/adr/0013-in-app-notifications.md).
 * Same repeatable-job shape as ReconciliationProcessor
 * (payments/internal/reconciliation.processor.ts), daily instead of hourly.
 */
@Processor(NOTIFICATION_RETENTION_QUEUE)
export class NotificationRetentionProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(NotificationRetentionProcessor.name);

  constructor(
    @InjectQueue(NOTIFICATION_RETENTION_QUEUE) private readonly queue: Queue,
    private readonly notificationService: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RETENTION_JOB_NAME,
      { every: RETENTION_INTERVAL_MS },
      { name: RETENTION_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    const olderThan = new Date(
      Date.now() -
        this.config.notifications.retentionDays * 24 * 60 * 60 * 1000,
    );
    const deleted =
      await this.notificationService.deleteExpiredNotifications(olderThan);
    this.logger.debug(
      `Deleted ${deleted} notification row(s) older than ${olderThan.toISOString()}`,
    );
  }
}
