import { ApiProperty } from '@nestjs/swagger';
import { Notification } from '../entities/notification.entity';

export class NotificationItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  data: Record<string, unknown>;

  @ApiProperty({ nullable: true })
  readAt: string | null;

  @ApiProperty()
  createdAt: string;
}

export function toNotificationItem(
  notification: Notification,
): NotificationItemDto {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: notification.data,
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  };
}
