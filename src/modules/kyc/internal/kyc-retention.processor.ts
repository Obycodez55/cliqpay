import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../../../config';
import { KycService } from '../kyc.service';

export const KYC_RETENTION_QUEUE = 'kyc-retention';
const RETENTION_JOB_NAME = 'prune-kyc-bookkeeping';
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Processor(KYC_RETENTION_QUEUE)
export class KycRetentionProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(KycRetentionProcessor.name);

  constructor(
    @InjectQueue(KYC_RETENTION_QUEUE) private readonly queue: Queue,
    private readonly kycService: KycService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RETENTION_JOB_NAME,
      { every: RETENTION_INTERVAL_MS },
      { name: RETENTION_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    const olderThan = new Date(
      Date.now() - this.config.kyc.retentionDays * 24 * 60 * 60 * 1000,
    );
    const { livenessJobs, attempts } =
      await this.kycService.pruneBookkeeping(olderThan);
    this.logger.debug(
      `Deleted ${attempts} attempt(s) and ${livenessJobs} settled liveness job(s) older than ${olderThan.toISOString()}`,
    );
  }
}
