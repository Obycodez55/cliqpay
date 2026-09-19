import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { Dispute } from './entities/dispute.entity';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

// Imports ledger/users via their exported services only, and never
// transfers/withdrawals/any peripheral module — see
// docs/adr/0016-disputes-module-boundary.md.
@Module({
  imports: [
    TypeOrmModule.forFeature([Dispute]),
    LedgerModule,
    UsersModule,
    EventBusModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
