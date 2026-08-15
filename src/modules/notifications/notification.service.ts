import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
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
  pushTemplates,
  smsTemplates,
} from './templates/templates';
import { PushPlatform, PushToken } from './entities/push-token.entity';

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
