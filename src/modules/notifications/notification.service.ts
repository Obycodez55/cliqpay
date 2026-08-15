import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  NOTIFICATION_CATALOG,
  NotificationChannel,
  NotificationPayloadMap,
  NotificationType,
} from './notification-catalog';
import {
  EmailSender,
  EMAIL_SENDER,
} from './channels/email/email-sender.interface';
import { SmsSender, SMS_SENDER } from './channels/sms/sms-sender.interface';
import { PushSender, PUSH_SENDER } from './channels/push/push-sender.interface';
import {
  PushContent,
  emailTemplates,
  inAppTemplates,
  pushTemplates,
  smsTemplates,
} from './templates/templates';
import { PushPlatform, PushToken } from './entities/push-token.entity';
import { Notification } from './entities/notification.entity';
import { isUniqueViolation } from './internal/errors';
import {
  NotificationItemDto,
  toNotificationItem,
} from './dto/notification-item.dto';

const NOTIFICATION_DEDUPE_CONSTRAINT =
  'UQ_notifications_user_id_type_dedupe_key';

export interface NotificationListPagination {
  cursor?: string;
  limit: number;
  unreadOnly?: boolean;
}

export interface MarkNotificationsReadParams {
  ids?: string[];
  all?: boolean;
}

/**
 * The one exported surface of the notifications module — see
 * docs/architecture.md §10. Everything else (adapters, templates, catalog,
 * processors) is internal to this module.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    @Inject(PUSH_SENDER) private readonly pushSender: PushSender,
    @InjectRepository(PushToken)
    private readonly pushTokens: Repository<PushToken>,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  async send<T extends NotificationType>(
    type: T,
    payload: NotificationPayloadMap[T],
  ): Promise<void> {
    const channels: readonly NotificationChannel[] =
      NOTIFICATION_CATALOG[type].channels;
    await Promise.all(
      channels.map((channel) => this.dispatchToChannel(channel, type, payload)),
    );
  }

  async sendToChannel<T extends NotificationType>(
    channel: NotificationChannel,
    type: T,
    payload: NotificationPayloadMap[T],
  ): Promise<void> {
    await this.dispatchToChannel(channel, type, payload);
  }

  private dispatchToChannel(
    channel: NotificationChannel,
    type: NotificationType,
    payload: unknown,
  ): Promise<void> {
    switch (channel) {
      case 'email':
        return this.sendEmail(type, payload);
      case 'sms':
        return this.sendSms(type, payload);
      case 'push':
        return this.sendPush(type, payload);
      case 'in_app':
        return this.sendInApp(type, payload);
    }
  }

  async registerPushToken(
    userId: string,
    platform: PushPlatform,
    token: string,
  ): Promise<void> {
    await this.pushTokens.upsert(
      { userId, platform, token, lastUsedAt: new Date() },
      ['token'],
    );
  }

  // Payload shape varies per notification type (email vs phone vs
  // userId-for-push); the public `send<T>` above stays fully typed via
  // NotificationPayloadMap, these internal handlers work generically across
  // whatever payload the catalog routes to them.
  private async sendEmail(
    type: NotificationType,
    payload: unknown,
  ): Promise<void> {
    const render = emailTemplates[type];
    if (!render) {
      // The catalog routed this type to email but no template exists for
      // it — a bug to fix, not a delivery failure retries could resolve.
      throw new UnrecoverableError(
        `No email template registered for notification type "${type}"`,
      );
    }
    const { email } = payload as { email: string };
    const content = render(payload as never);
    await this.emailSender.send({ to: email, ...content });
  }

  private async sendSms(
    type: NotificationType,
    payload: unknown,
  ): Promise<void> {
    const render = smsTemplates[type];
    if (!render) {
      throw new UnrecoverableError(
        `No SMS template registered for notification type "${type}"`,
      );
    }
    const { phone } = payload as { phone: string };
    const content = render(payload as never);
    await this.smsSender.send({ to: phone, ...content });
  }

  private async sendPush(
    type: NotificationType,
    payload: unknown,
  ): Promise<void> {
    const render = pushTemplates[type];
    if (!render) {
      throw new UnrecoverableError(
        `No push template registered for notification type "${type}"`,
      );
    }
    const { userId } = payload as { userId: string };
    const content = render(payload as never);
    const tokens = await this.pushTokens.find({ where: { userId } });
    await Promise.all(
      tokens.map((token) => this.sendPushToToken(token.token, content)),
    );
  }

  private async sendInApp(
    type: NotificationType,
    payload: unknown,
  ): Promise<void> {
    const render = inAppTemplates[type];
    if (!render) {
      throw new UnrecoverableError(
        `No in-app template registered for notification type "${type}"`,
      );
    }
    const { userId } = payload as { userId: string };
    const content = render(payload as never);
    try {
      const notification = this.notifications.create({
        userId,
        type,
        data: content.data,
        title: content.title,
        body: content.body,
        dedupeKey: content.dedupeKey,
      });
      await this.notifications.save(notification);
    } catch (error) {
      // A (user_id, type, dedupe_key) collision means a worker already
      // wrote this row and died before acking — a legitimate no-op, not a
      // delivery failure to retry.
      if (isUniqueViolation(error, NOTIFICATION_DEDUPE_CONSTRAINT)) {
        return;
      }
      throw error;
    }
  }

  async listNotifications(
    userId: string,
    pagination: NotificationListPagination,
  ): Promise<PaginatedResult<NotificationItemDto>> {
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;

    const query = this.notifications
      .createQueryBuilder('notification')
      // Same reasoning as LedgerService.getTransactionHistory: compare on
      // Postgres's own text form of created_at, not the millisecond-precision
      // JS Date, so rows sharing a millisecond never get silently skipped
      // at the page boundary.
      .addSelect('"notification"."created_at"::text', 'raw_created_at')
      .where('notification.userId = :userId', { userId })
      .orderBy('notification.createdAt', 'DESC')
      .addOrderBy('notification.id', 'DESC')
      .take(pagination.limit + 1);

    if (pagination.unreadOnly) {
      query.andWhere('notification.readAt IS NULL');
    }

    if (cursor) {
      query.andWhere(
        '(notification.createdAt, notification.id) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > pagination.limit;
    const page = hasMore ? entities.slice(0, pagination.limit) : entities;
    const lastRaw = hasMore ? raw[pagination.limit - 1] : raw[raw.length - 1];

    return {
      items: page.map(toNotificationItem),
      nextCursor:
        hasMore && lastRaw
          ? encodeCreatedAtIdCursor({
              createdAt: lastRaw.raw_created_at,
              id: page[page.length - 1].id,
            })
          : null,
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notifications
      .createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId })
      .andWhere('notification.readAt IS NULL')
      .getCount();
  }

  // Every branch scopes by userId in the WHERE clause itself, never by
  // fetching then checking — a cross-user id in `ids` is filtered out of
  // the UPDATE and silently affects 0 rows, not a 403 that would confirm
  // the row exists (docs/adr/0013-in-app-notifications.md). The `readAt IS
  // NULL` guard on both branches is what makes a repeat call idempotent:
  // an already-read row is excluded, so a second call moves nothing.
  async markRead(
    userId: string,
    params: MarkNotificationsReadParams,
  ): Promise<void> {
    if (params.all) {
      await this.notifications
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: () => 'now()' })
        .where('user_id = :userId', { userId })
        .andWhere('read_at IS NULL')
        .execute();
      return;
    }
    if (params.ids?.length) {
      await this.notifications
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: () => 'now()' })
        .where('user_id = :userId', { userId })
        .andWhere('id IN (:...ids)', { ids: params.ids })
        .andWhere('read_at IS NULL')
        .execute();
    }
  }

  // The retention job's only entry point — see internal/retention.processor.ts.
  // A genuine DELETE, not subject to ledger_entries' append-only rule
  // (that rule is specific to the ledger, see CLAUDE.md).
  async deleteExpiredNotifications(olderThan: Date): Promise<number> {
    const result = await this.notifications
      .createQueryBuilder()
      .delete()
      .from(Notification)
      .where('created_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }

  private async sendPushToToken(
    token: string,
    content: PushContent,
  ): Promise<void> {
    try {
      await this.pushSender.send({ token, ...content });
    } catch (error) {
      // A dead token is deleted by the adapter itself before it throws —
      // one bad device shouldn't fail delivery to the user's other devices,
      // or fail the whole notification job.
      if (error instanceof UnrecoverableError) {
        return;
      }
      throw error;
    }
  }
}
