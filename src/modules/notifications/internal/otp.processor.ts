import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PRIORITY_DISPATCH_QUEUE } from '../../../shared/events/event-bus.service';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { NotificationService } from '../notification.service';
import {
  NOTIFICATION_CATALOG,
  NotificationPayloadMap,
  NotificationType,
} from '../notification-catalog';

function isKnownNotificationType(name: string): name is NotificationType {
  return name in NOTIFICATION_CATALOG;
}

/**
 * Consumer for the synchronous, priority-queued dispatch path — see
 * EventBusService.dispatchAndAwait (src/shared/events/event-bus.service.ts).
 * `PRIORITY_DISPATCH_QUEUE` is a general awaited-dispatch queue, so job names
 * this module doesn't own are skipped rather than assumed to be a
 * NotificationType, in case a future caller reuses the same queue for
 * something else. Throwing UnrecoverableError for a job this processor does
 * own fails it immediately, which is what makes the caller's
 * `waitUntilFinished` reject promptly instead of burning its timeout budget
 * on retries that could never succeed.
 */
@Processor(PRIORITY_DISPATCH_QUEUE)
export class OtpNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(OtpNotificationProcessor.name);

  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    if (!isKnownNotificationType(job.name)) {
      this.logger.debug(
        `Ignoring priority-dispatch job "${job.name}" — not a notification type this module handles`,
      );
      return;
    }
    await this.notifications.send(
      job.name,
      job.data.payload as NotificationPayloadMap[NotificationType],
    );
  }
}
