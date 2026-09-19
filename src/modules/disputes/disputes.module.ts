import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

// No TypeOrmModule.forFeature([Dispute]) — DisputesService reaches
// `disputes` only via its own injected DataSource (manager.getRepository /
// dataSource.getRepository), never an injected Repository<Dispute>, since
// its one write path needs a transaction-scoped manager regardless
// (CLAUDE.md's repository-access rule). Imports ledger/users via their
// exported services only, and never transfers/withdrawals/any peripheral
// module — see docs/adr/0016-disputes-module-boundary.md.
@Module({
  imports: [LedgerModule, UsersModule, EventBusModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
