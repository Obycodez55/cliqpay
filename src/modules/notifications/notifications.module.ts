import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  DOMAIN_EVENTS_QUEUE,
  PRIORITY_DISPATCH_QUEUE,
} from '../../shared/events/event-bus.service';
import { PushToken } from './entities/push-token.entity';
import { Notification } from './entities/notification.entity';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';
import { NotificationEventsProcessor } from './internal/notification-events.processor';
import { OtpNotificationProcessor } from './internal/otp.processor';
import { ChannelDispatchProcessor } from './internal/channel-dispatch.processor';
import { CHANNEL_DISPATCH_QUEUE } from './internal/channel-dispatch.queue';
import {
  NOTIFICATION_RETENTION_QUEUE,
  NotificationRetentionProcessor,
} from './internal/retention.processor';
import {
  EMAIL_SENDER,
  EmailSender,
} from './channels/email/email-sender.interface';
import { BrevoEmailAdapter } from './channels/email/brevo-email.adapter';
import { FakeEmailAdapter } from './channels/email/fake-email.adapter';
import { SMS_SENDER, SmsSender } from './channels/sms/sms-sender.interface';
import { TermiiSmsAdapter } from './channels/sms/termii-sms.adapter';
import { FakeSmsAdapter } from './channels/sms/fake-sms.adapter';
import { PUSH_SENDER, PushSender } from './channels/push/push-sender.interface';
import { FcmPushAdapter } from './channels/push/fcm-push.adapter';
import { FakePushAdapter } from './channels/push/fake-push.adapter';

// One entry per provider a channel can be pointed at — `fake` is just
// another entry, not a separate real/fake axis. Adding a second real
// provider for a channel (e.g. SES alongside Brevo) is one new map entry
// plus one enum value in src/config/index.ts, not a restructure. `satisfies
// Record<...>` keyed off AppConfig's own provider union means TS won't
// compile if a provider is added to the config enum without a map entry,
// or vice versa.
const EMAIL_ADAPTERS = {
  brevo: (config: AppConfig): EmailSender => new BrevoEmailAdapter(config),
  fake: (): EmailSender => new FakeEmailAdapter(),
} satisfies Record<
  AppConfig['notifications']['emailProvider'],
  (config: AppConfig) => EmailSender
>;

const SMS_ADAPTERS = {
  termii: (config: AppConfig): SmsSender => new TermiiSmsAdapter(config),
  fake: (): SmsSender => new FakeSmsAdapter(),
} satisfies Record<
  AppConfig['notifications']['smsProvider'],
  (config: AppConfig) => SmsSender
>;

const PUSH_ADAPTERS = {
  fcm: (config: AppConfig, pushTokens: Repository<PushToken>): PushSender =>
    new FcmPushAdapter(config, pushTokens),
  fake: (): PushSender => new FakePushAdapter(),
} satisfies Record<
  AppConfig['notifications']['pushProvider'],
  (config: AppConfig, pushTokens: Repository<PushToken>) => PushSender
>;

// Real adapters are only ever constructed when their channel's provider
// selects them — constructing e.g. FcmPushAdapter eagerly would call
// firebase-admin's `cert()`, which throws immediately on missing
// credentials. This is what lets a dev with zero real API keys run
// everything on fakes (EMAIL_PROVIDER=fake etc., the .env.example default).
@Module({
  imports: [
    // Only the notifications list/unread-count/mark-read endpoints need
    // this — every other provider here is queue-driven, not HTTP.
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
    }),
    TypeOrmModule.forFeature([PushToken, Notification]),
    BullModule.registerQueue({ name: DOMAIN_EVENTS_QUEUE }),
    BullModule.registerQueue({ name: PRIORITY_DISPATCH_QUEUE }),
    // Internal to this module — no other module publishes or consumes it,
    // unlike the two queues above. Same attempts/backoff/removal shape as
    // DOMAIN_EVENTS_QUEUE; each job here delivers exactly one channel, so
    // its retry budget never spills over into another channel's delivery.
    BullModule.registerQueue({
      name: CHANNEL_DISPATCH_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    }),
    // Its own queue, same reasoning as CHANNEL_DISPATCH_QUEUE above and as
    // RECONCILIATION_QUEUE (payments) — a daily scheduled job, independent
    // of every other queue's schedule and retry budget.
    BullModule.registerQueue({ name: NOTIFICATION_RETENTION_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    NotificationEventsProcessor,
    OtpNotificationProcessor,
    ChannelDispatchProcessor,
    NotificationRetentionProcessor,
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EmailSender =>
        EMAIL_ADAPTERS[config.notifications.emailProvider](config),
    },
    {
      provide: SMS_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SmsSender =>
        SMS_ADAPTERS[config.notifications.smsProvider](config),
    },
    {
      provide: PUSH_SENDER,
      inject: [APP_CONFIG, getRepositoryToken(PushToken)],
      useFactory: (
        config: AppConfig,
        pushTokens: Repository<PushToken>,
      ): PushSender =>
        PUSH_ADAPTERS[config.notifications.pushProvider](config, pushTokens),
    },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
