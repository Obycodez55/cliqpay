import { Inject, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../../../config';
import { RunEngine } from './run-engine.service';
import { SCHEDULED_PAYMENT_SWEEP_QUEUE } from './queues';

const SWEEP_JOB_NAME = 'sweep-due-schedules';
const REMINDER_JOB_NAME = 'remind-upcoming-runs';

@Processor(SCHEDULED_PAYMENT_SWEEP_QUEUE)
export class SweepProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @InjectQueue(SCHEDULED_PAYMENT_SWEEP_QUEUE) private readonly queue: Queue,
    private readonly runEngine: RunEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SWEEP_JOB_NAME,
      { every: this.config.scheduledPayments.sweepIntervalMs },
      { name: SWEEP_JOB_NAME },
    );
    await this.queue.upsertJobScheduler(
      REMINDER_JOB_NAME,
      { pattern: '0 18 * * *', tz: 'Africa/Lagos' },
      { name: REMINDER_JOB_NAME },
    );
  }

  async process(job: Job): Promise<void> {
    if (job.name === REMINDER_JOB_NAME) {
      await this.runEngine.sendUpcomingReminders();
      return;
    }
    await this.runEngine.sweep();
  }
}
