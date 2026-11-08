import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { SocialModule } from '../social/social.module';
import { TransfersModule } from '../transfers/transfers.module';
import { UsersModule } from '../users/users.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { EventBusService } from '../../shared/events/event-bus.service';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { RunEngine } from './internal/run-engine.service';
import { RunProcessor } from './internal/run.processor';
import { SweepProcessor } from './internal/sweep.processor';
import {
  SCHEDULED_PAYMENT_RUNS_QUEUE,
  SCHEDULED_PAYMENT_SWEEP_QUEUE,
} from './internal/queues';
import { SettlementEventsProcessor } from './internal/settlement-events.processor';
import {
  SCHEDULED_PAYMENT_SETTLEMENT_EVENTS,
  SCHEDULED_PAYMENT_SETTLEMENT_QUEUE,
} from './internal/settlement-events.queue';

@Module({
  imports: [
    TransfersModule,
    WithdrawalsModule,
    UsersModule,
    AuthModule,
    KycModule,
    LedgerModule,
    SocialModule,
    EventBusModule,
    BullModule.registerQueue(
      {
        name: SCHEDULED_PAYMENT_SWEEP_QUEUE,
        defaultJobOptions: {
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400, count: 5_000 },
        },
      },
      {
        name: SCHEDULED_PAYMENT_SETTLEMENT_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400, count: 5_000 },
        },
      },
      {
        name: SCHEDULED_PAYMENT_RUNS_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ),
  ],
  controllers: [SchedulingController],
  providers: [
    SchedulingService,
    RunEngine,
    SweepProcessor,
    RunProcessor,
    SettlementEventsProcessor,
  ],
  exports: [SchedulingService],
})
export class SchedulingModule implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBusService,
    @InjectQueue(SCHEDULED_PAYMENT_SETTLEMENT_QUEUE)
    private readonly settlementQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(
      this.settlementQueue,
      SCHEDULED_PAYMENT_SETTLEMENT_EVENTS,
    );
  }
}
