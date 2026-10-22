import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG, AppConfig } from '../../config';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { UsersModule } from '../users/users.module';
import { KycController } from './kyc.controller';
import {
  LIVENESS_POLL_QUEUE,
  LivenessPollProcessor,
} from './internal/liveness-poll.processor';
import { KycService } from './kyc.service';
import { KYC_PROVIDER, KycProvider } from './providers/kyc-provider.interface';
import { SmileIdKycProvider } from './providers/smile-id.provider';
import { FakeKycProvider } from './providers/fake.provider';

const KYC_PROVIDERS = {
  smileid: (config: AppConfig): KycProvider => new SmileIdKycProvider(config),
  fake: (): KycProvider => new FakeKycProvider(),
} satisfies Record<
  AppConfig['kyc']['provider'],
  (config: AppConfig) => KycProvider
>;

@Module({
  imports: [
    UsersModule,
    EventBusModule,
    BullModule.registerQueue({
      name: LIVENESS_POLL_QUEUE,
      defaultJobOptions: {
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 86_400, count: 500 },
      },
    }),
  ],
  controllers: [KycController],
  providers: [
    KycService,
    LivenessPollProcessor,
    {
      provide: KYC_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): KycProvider =>
        KYC_PROVIDERS[config.kyc.provider](config),
    },
  ],
  exports: [KycService],
})
export class KycModule {}
