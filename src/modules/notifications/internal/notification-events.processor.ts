import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { DOMAIN_EVENTS_QUEUE } from '../../../shared/events/event-bus.service';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import {
  NOTIFICATION_CATALOG,
  NotificationChannel,
  NotificationType,
} from '../notification-catalog';
import {
  CHANNEL_DISPATCH_QUEUE,
  ChannelDispatchJobData,
} from './channel-dispatch.queue';

function isKnownNotificationType(name: string): name is NotificationType {
  return name in NOTIFICATION_CATALOG;
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

  constructor(
    @InjectQueue(CHANNEL_DISPATCH_QUEUE)
    private readonly channelDispatchQueue: Queue<ChannelDispatchJobData>,
  ) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    if (!isKnownNotificationType(job.name)) {
      this.logger.debug(
        `Ignoring domain event "${job.name}" — not a notification type this module handles`,
      );
      return;
    }
    const type: NotificationType = job.name;
    const channels: readonly NotificationChannel[] =
      NOTIFICATION_CATALOG[type].channels;
    // This job is "done" once each channel's job is enqueued, not once
    // they've delivered — that's what keeps one channel's BullMQ retry
    // budget from resending a channel that already succeeded.
    await Promise.all(
      channels.map((channel) =>
        this.channelDispatchQueue.add(type, {
          channel,
          type,
          payload: job.data.payload,
        }),
      ),
    );
  }
}
