import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { EventBusService } from '../../shared/events/event-bus.service';
import { TransfersModule } from '../transfers/transfers.module';
import { UsersModule } from '../users/users.module';
import { BillSplitController } from './billsplit.controller';
import { BillSplitService } from './billsplit.service';
import { BillSplitEventsProcessor } from './internal/bill-split-events.processor';
import {
  BILL_SPLIT_EVENTS_QUEUE,
  BILL_SPLIT_SUBSCRIBED_EVENTS,
} from './internal/bill-split-events.queue';

@Module({
  imports: [
    TransfersModule,
    UsersModule,
    EventBusModule,
    BullModule.registerQueue({
      name: BILL_SPLIT_EVENTS_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    }),
  ],
  controllers: [BillSplitController],
  providers: [BillSplitService, BillSplitEventsProcessor],
  exports: [BillSplitService],
})
export class BillSplitModule implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBusService,
    @InjectQueue(BILL_SPLIT_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(this.queue, BILL_SPLIT_SUBSCRIBED_EVENTS);
  }
}
