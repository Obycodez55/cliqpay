import { Module } from '@nestjs/common';
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

@Module({
  imports: [UsersModule, LedgerModule, EventBusModule],
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    MfaService,
    VerificationCodeService,
    TransactionPinService,
    SessionService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
