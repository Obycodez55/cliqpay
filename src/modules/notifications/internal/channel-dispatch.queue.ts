import { NotificationChannel, NotificationType } from '../notification-catalog';

export const CHANNEL_DISPATCH_QUEUE = 'notification-channel-dispatch';

export interface ChannelDispatchJobData {
  channel: NotificationChannel;
  type: NotificationType;
  payload: unknown;
}
