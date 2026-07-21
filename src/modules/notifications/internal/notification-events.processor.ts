import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DOMAIN_EVENTS_QUEUE } from '../../../shared/events/event-bus.service';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { NotificationService } from '../notification.service';
import {
  NOTIFICATION_CATALOG,
  NotificationPayloadMap,
  NotificationType,
} from '../notification-catalog';

function isFireAndForgetNotificationType(
  name: string,
): name is NotificationType {
  return (
    name in NOTIFICATION_CATALOG &&
    !NOTIFICATION_CATALOG[name as NotificationType].isOtp
  );
}

/**
 * Notifications' own fire-and-forget consumer — see docs/architecture.md
 * §10. `DOMAIN_EVENTS_QUEUE` is shared app-wide, not notifications-owned, so
 * this is the only worker on it today rather than the canonical handler of
 * it; unrecognized job names are skipped rather than thrown so the queue can
 * carry other modules' domain events once they exist, without notifications
 * choking on them.
 */
@Processor(DOMAIN_EVENTS_QUEUE)
export class NotificationEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationEventsProcessor.name);

  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    if (!isFireAndForgetNotificationType(job.name)) {
      this.logger.debug(
        `Ignoring domain event "${job.name}" — not a notification type this module handles`,
      );
      return;
    }
    await this.notifications.send(
      job.name,
      job.data.payload as NotificationPayloadMap[NotificationType],
    );
  }
}
