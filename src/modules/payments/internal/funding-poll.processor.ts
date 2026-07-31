import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PaymentsService } from '../payments.service';

// Its own queue, not DOMAIN_EVENTS_QUEUE — that queue carries notification-
// catalog-driven domain events dispatched by name; this is a single fixed
// recurring maintenance job with no relation to that traffic.
export const FUNDING_POLL_QUEUE = 'funding-poll';
const FUNDING_POLL_JOB_NAME = 'poll-stale-funding';
const FUNDING_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The first scheduled/recurring job in this codebase (issue #14) — a
 * repeatable job via `upsertJobScheduler`, not a per-event `queue.add()`
 * like NotificationEventsProcessor's queue. Nothing else ever adds a job to
 * this queue, so the schedule is registered here, alongside the one
 * processor that ever runs it.
 */
@Processor(FUNDING_POLL_QUEUE)
export class FundingPollProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(FundingPollProcessor.name);

  constructor(
    @InjectQueue(FUNDING_POLL_QUEUE) private readonly queue: Queue,
    private readonly paymentsService: PaymentsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      FUNDING_POLL_JOB_NAME,
      { every: FUNDING_POLL_INTERVAL_MS },
      { name: FUNDING_POLL_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    this.logger.debug('Polling stale funding transactions');
    await this.paymentsService.pollStaleFundingTransactions();
  }
}
