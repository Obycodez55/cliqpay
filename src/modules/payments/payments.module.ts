import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG, AppConfig } from '../../config';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PAYMENT_PROVIDER_ADAPTER,
  PaymentProviderAdapter,
} from './adapters/payment-provider.interface';
import { KoraAdapter } from './adapters/kora.adapter';
import { FakeAdapter } from './adapters/fake.adapter';
import {
  FUNDING_POLL_QUEUE,
  FundingPollProcessor,
} from './internal/funding-poll.processor';

// Same one-entry-per-provider pattern as NotificationsModule's channel
// adapters (see that module's own comment) — `fake` is just another entry,
// not a separate real/fake axis.
const PAYMENT_ADAPTERS = {
  kora: (config: AppConfig): PaymentProviderAdapter => new KoraAdapter(config),
  fake: (): PaymentProviderAdapter => new FakeAdapter(),
} satisfies Record<
  AppConfig['payments']['provider'],
  (config: AppConfig) => PaymentProviderAdapter
>;

@Module({
  imports: [
    LedgerModule,
    UsersModule,
    EventBusModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
    }),
    BullModule.registerQueue({
      name: FUNDING_POLL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 86_400, count: 500 },
      },
    }),
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    FundingPollProcessor,
    {
      provide: PAYMENT_PROVIDER_ADAPTER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PaymentProviderAdapter =>
        PAYMENT_ADAPTERS[config.payments.provider](config),
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
