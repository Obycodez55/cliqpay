import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NotificationService } from '../notification.service';
import { SocialService } from '../../social/social.service';
import {
  NotificationPayloadMap,
  NotificationType,
} from '../notification-catalog';
import {
  CHANNEL_DISPATCH_QUEUE,
  ChannelDispatchJobData,
} from './channel-dispatch.queue';

// Social notifications are dropped when either side has blocked the other.
// Checked here, per delivery, so a block created after the triggering event
// still stops it.
function blockCheckedPair(
  type: NotificationType,
  payload: unknown,
): [string, string] | null {
  switch (type) {
    case 'new_follower': {
      const { userId, followerUserId } =
        payload as NotificationPayloadMap['new_follower'];
      return [userId, followerUserId];
    }
    default:
      return null;
  }
}

/**
 * One job per (type, channel) pair, enqueued by NotificationEventsProcessor
 * — each job's retry budget only ever affects the one channel it delivers
 * to, so a push failure can no longer cause an already-sent email to be
 * resent. See docs/adr/0013-in-app-notifications.md.
 */
@Processor(CHANNEL_DISPATCH_QUEUE)
export class ChannelDispatchProcessor extends WorkerHost {
  constructor(
    private readonly notifications: NotificationService,
    private readonly socialService: SocialService,
  ) {
    super();
  }

  async process(job: Job<ChannelDispatchJobData>): Promise<void> {
    const pair = blockCheckedPair(job.data.type, job.data.payload);
    if (pair && (await this.socialService.isBlockedBetween(...pair))) {
      return;
    }
    await this.notifications.sendToChannel(
      job.data.channel,
      job.data.type,
      job.data.payload as NotificationPayloadMap[NotificationType],
    );
  }
}
