import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { AuditModule } from '../../shared/audit/audit.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { VerificationCodeService } from './verification-code.service';
import { TransactionPinService } from './transaction-pin.service';
import { SessionService } from './session.service';
import { DeviceBindingService } from './device-binding.service';
import { DeviceChallenge } from './entities/device-challenge.entity';
import { AppleAppAttestVerifier } from './attestation/apple-app-attest.verifier';
import { DEVICE_ATTESTATION_VERIFIER } from './attestation/device-attestation-verifier';
import { FakeDeviceAttestationVerifier } from './attestation/fake-device-attestation.verifier';
import { GooglePlayIntegrityVerifier } from './attestation/google-play-integrity.verifier';
import { PlatformDeviceAttestationVerifier } from './attestation/platform-device-attestation.verifier';

@Module({
  imports: [
    UsersModule,
    LedgerModule,
    EventBusModule,
    AuditModule,
    TypeOrmModule.forFeature([DeviceChallenge]),
  ],
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    MfaService,
    VerificationCodeService,
    TransactionPinService,
    SessionService,
    DeviceBindingService,
    AppleAppAttestVerifier,
    GooglePlayIntegrityVerifier,
    PlatformDeviceAttestationVerifier,
    FakeDeviceAttestationVerifier,
    {
      provide: DEVICE_ATTESTATION_VERIFIER,
      inject: [
        APP_CONFIG,
        PlatformDeviceAttestationVerifier,
        FakeDeviceAttestationVerifier,
      ],
      useFactory: (
        config: AppConfig,
        platform: PlatformDeviceAttestationVerifier,
        fake: FakeDeviceAttestationVerifier,
      ) => (config.device.attestation.provider === 'fake' ? fake : platform),
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
