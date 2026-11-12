import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { KycModule } from '../kyc/kyc.module';
import { RiskModule } from '../risk/risk.module';
import { SocialModule } from '../social/social.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { RecipientController } from './recipient.controller';
import { MoneyRequestsController } from './money-requests.controller';
import { MoneyRequestsService } from './money-requests.service';
import { MoneyRequest } from './entities/money-request.entity';

@Module({
  imports: [
    LedgerModule,
    UsersModule,
    AuthModule,
    KycModule,
    SocialModule,
    RiskModule,
    EventBusModule,
    TypeOrmModule.forFeature([MoneyRequest]),
  ],
  controllers: [
    TransfersController,
    MoneyRequestsController,
    RecipientController,
  ],
  // MoneyRequestsService is internal to this module, same as
  // MfaService/SessionService/TransactionPinService in AuthModule — only
  // TransfersService is exported.
  providers: [TransfersService, MoneyRequestsService],
  exports: [TransfersService],
})
export class TransfersModule {}
