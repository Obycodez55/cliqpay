import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config';
import { UsersModule } from '../users/users.module';
import { KycController } from './kyc.controller';
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
  imports: [UsersModule],
  controllers: [KycController],
  providers: [
    KycService,
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
