import { OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { KycService } from '../kyc.service';

export const LIVENESS_POLL_QUEUE = 'kyc-liveness-poll';
const LIVENESS_POLL_JOB_NAME = 'poll-pending-liveness';
const LIVENESS_POLL_INTERVAL_MS = 15 * 1000;

@Processor(LIVENESS_POLL_QUEUE)
export class LivenessPollProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @InjectQueue(LIVENESS_POLL_QUEUE) private readonly queue: Queue,
    private readonly kycService: KycService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      LIVENESS_POLL_JOB_NAME,
      { every: LIVENESS_POLL_INTERVAL_MS },
      { name: LIVENESS_POLL_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    await this.kycService.pollPendingLivenessJobs();
  }
}
