import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { BillSplitService } from '../billsplit.service';
import { BILL_SPLIT_EVENTS_QUEUE } from './bill-split-events.queue';

@Processor(BILL_SPLIT_EVENTS_QUEUE)
export class BillSplitEventsProcessor extends WorkerHost {
  constructor(private readonly billSplitService: BillSplitService) {
    super();
  }

  async process(
    job: Job<DomainEventEnvelope<string, { moneyRequestId: string }>>,
  ): Promise<void> {
    await this.billSplitService.recordOutcomeForRequest(
      job.data.payload.moneyRequestId,
    );
  }
}
