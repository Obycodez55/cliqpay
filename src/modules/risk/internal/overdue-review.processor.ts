import { OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { RiskService } from '../risk.service';
import { RISK_REVIEW_OVERDUE_QUEUE } from './queues';

const JOB_NAME = 'alert-overdue-reviews';
const INTERVAL_MS = 6 * 60 * 60 * 1000;

@Processor(RISK_REVIEW_OVERDUE_QUEUE)
export class OverdueReviewProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @InjectQueue(RISK_REVIEW_OVERDUE_QUEUE) private readonly queue: Queue,
    private readonly riskService: RiskService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_NAME,
      { every: INTERVAL_MS },
      { name: JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    await this.riskService.alertOverdueReviews();
  }
}
