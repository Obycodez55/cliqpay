import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  ACCOUNT_SELF_LOCKED_EVENT,
  AccountSelfLockedEventPayload,
  DomainEventEnvelope,
  WITHDRAWAL_COMPLETED_EVENT,
} from '../../../shared/events/domain-events';
import { SchedulingService } from '../scheduling.service';
import { RunEngine } from './run-engine.service';
import { SCHEDULED_PAYMENT_SETTLEMENT_QUEUE } from './settlement-events.queue';

@Processor(SCHEDULED_PAYMENT_SETTLEMENT_QUEUE)
export class SettlementEventsProcessor extends WorkerHost {
  constructor(
    private readonly runEngine: RunEngine,
    private readonly schedulingService: SchedulingService,
  ) {
    super();
  }

  async process(job: Job<DomainEventEnvelope<string, unknown>>): Promise<void> {
    if (job.data.name === ACCOUNT_SELF_LOCKED_EVENT) {
      await this.schedulingService.pauseAllForAccountLock(
        (job.data.payload as AccountSelfLockedEventPayload).userId,
      );
      return;
    }
    const { reference } = job.data.payload as { reference: string };
    await this.runEngine.recordSettlement(
      job.data.name === WITHDRAWAL_COMPLETED_EVENT ? 'completed' : 'failed',
      reference,
    );
  }
}
