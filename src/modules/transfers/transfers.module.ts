import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { MoneyRequestsController } from './money-requests.controller';
import { MoneyRequestsService } from './money-requests.service';
import { MoneyRequest } from './entities/money-request.entity';

@Module({
  imports: [
    LedgerModule,
    UsersModule,
    AuthModule,
    EventBusModule,
    TypeOrmModule.forFeature([MoneyRequest]),
  ],
  controllers: [TransfersController, MoneyRequestsController],
  // MoneyRequestsService is internal to this module, same as
  // MfaService/SessionService/TransactionPinService in AuthModule — only
  // TransfersService is exported.
  providers: [TransfersService, MoneyRequestsService],
  exports: [TransfersService],
})
export class TransfersModule {}
