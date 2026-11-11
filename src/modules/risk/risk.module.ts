import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditModule } from '../../shared/audit/audit.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { ScamCasesService } from './internal/scam-cases.service';
import { ScamCaseReviewController } from './scam-case-review.controller';
import { ScamReportsController } from './scam-reports.controller';
import { OverdueReviewProcessor } from './internal/overdue-review.processor';
import {
  RISK_EVENTS_QUEUE,
  RISK_REVIEW_OVERDUE_QUEUE,
  RISK_SUBSCRIBED_EVENTS,
} from './internal/queues';
import { RiskEventsProcessor } from './internal/risk-events.processor';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

@Module({
  imports: [
    LedgerModule,
    UsersModule,
    AuthModule,
    AuditModule,
    EventBusModule,
    BullModule.registerQueue(
      {
        name: RISK_EVENTS_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400, count: 5_000 },
        },
      },
      {
        name: RISK_REVIEW_OVERDUE_QUEUE,
        defaultJobOptions: {
          removeOnComplete: { age: 3_600, count: 100 },
          removeOnFail: { age: 86_400, count: 100 },
        },
      },
    ),
  ],
  controllers: [
    RiskController,
    ScamCaseReviewController,
    ScamReportsController,
  ],
  providers: [
    RiskService,
    ScamCasesService,
    RiskEventsProcessor,
    OverdueReviewProcessor,
  ],
  exports: [RiskService],
})
export class RiskModule implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBusService,
    @InjectQueue(RISK_EVENTS_QUEUE) private readonly eventsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(this.eventsQueue, RISK_SUBSCRIBED_EVENTS);
  }
}
