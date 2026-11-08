import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  DomainEventEnvelope,
  WITHDRAWAL_COMPLETED_EVENT,
} from '../../../shared/events/domain-events';
import { RunEngine } from './run-engine.service';
import { SCHEDULED_PAYMENT_SETTLEMENT_QUEUE } from './settlement-events.queue';

@Processor(SCHEDULED_PAYMENT_SETTLEMENT_QUEUE)
export class SettlementEventsProcessor extends WorkerHost {
  constructor(private readonly runEngine: RunEngine) {
    super();
  }

  async process(
    job: Job<DomainEventEnvelope<string, { reference: string }>>,
  ): Promise<void> {
    await this.runEngine.recordSettlement(
      job.data.name === WITHDRAWAL_COMPLETED_EVENT ? 'completed' : 'failed',
      job.data.payload.reference,
    );
  }
}
