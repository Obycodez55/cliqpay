import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { BillSplitService } from '../billsplit.service';
import { BillSplitParticipant } from '../entities/bill-split-participant.entity';
import { BILL_SPLIT_EVENTS_QUEUE } from './bill-split-events.queue';

@Processor(BILL_SPLIT_EVENTS_QUEUE)
export class BillSplitEventsProcessor extends WorkerHost {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly billSplitService: BillSplitService,
  ) {
    super();
  }

  async process(
    job: Job<DomainEventEnvelope<string, { moneyRequestId: string }>>,
  ): Promise<void> {
    const participant = await this.dataSource
      .getRepository(BillSplitParticipant)
      .findOneBy({ moneyRequestId: job.data.payload.moneyRequestId });
    if (participant) {
      await this.billSplitService.recordOutcome(participant.billSplitId);
    }
  }
}
