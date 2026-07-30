import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
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
