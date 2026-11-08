import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../../../config';
import { RunEngine } from './run-engine.service';
import { RunJobData, SCHEDULED_PAYMENT_RUNS_QUEUE } from './queues';

@Processor(SCHEDULED_PAYMENT_RUNS_QUEUE)
export class RunProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runEngine: RunEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  // Decorator options are fixed before config exists, so concurrency is set on the live worker.
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.scheduledPayments.workerConcurrency;
  }

  // An error that isn't a business rejection is retried by BullMQ; once its
  // attempts are spent the failure is recorded on the run.
  async process(job: Job<RunJobData>): Promise<void> {
    try {
      await this.runEngine.executeRun(job.data.runId);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 < attempts) {
        throw error;
      }
      await this.runEngine.recordInfrastructureFailure(job.data.runId);
    }
  }
}
