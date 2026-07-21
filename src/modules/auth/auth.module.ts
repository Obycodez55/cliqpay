import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../../config';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    LedgerModule,
    EventBusModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
