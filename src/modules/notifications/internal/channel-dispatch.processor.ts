import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NotificationService } from '../notification.service';
import {
  NotificationPayloadMap,
  NotificationType,
} from '../notification-catalog';
import {
  CHANNEL_DISPATCH_QUEUE,
  ChannelDispatchJobData,
} from './channel-dispatch.queue';

/**
 * One job per (type, channel) pair, enqueued by NotificationEventsProcessor
 * — each job's retry budget only ever affects the one channel it delivers
 * to, so a push failure can no longer cause an already-sent email to be
 * resent. See docs/adr/0013-in-app-notifications.md.
 */
@Processor(CHANNEL_DISPATCH_QUEUE)
export class ChannelDispatchProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async process(job: Job<ChannelDispatchJobData>): Promise<void> {
    await this.notifications.sendToChannel(
      job.data.channel,
      job.data.type,
      job.data.payload as NotificationPayloadMap[NotificationType],
    );
  }
}
