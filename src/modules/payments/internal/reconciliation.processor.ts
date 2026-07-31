import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PaymentsService } from '../payments.service';

// Its own queue, not FUNDING_POLL_QUEUE or DOMAIN_EVENTS_QUEUE — a
// different scheduled job with a different schedule, kept independent the
// same way FUNDING_POLL_QUEUE was kept independent of DOMAIN_EVENTS_QUEUE
// (see funding-poll.processor.ts).
export const RECONCILIATION_QUEUE = 'float-reconciliation';
const RECONCILIATION_JOB_NAME = 'reconcile-float-balances';
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The external reconciliation job (issue #15, docs/architecture.md §4.4) —
 * same repeatable-job shape as FundingPollProcessor, hourly instead of
 * every 5 minutes.
 */
@Processor(RECONCILIATION_QUEUE)
export class ReconciliationProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    @InjectQueue(RECONCILIATION_QUEUE) private readonly queue: Queue,
    private readonly paymentsService: PaymentsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RECONCILIATION_JOB_NAME,
      { every: RECONCILIATION_INTERVAL_MS },
      { name: RECONCILIATION_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    this.logger.debug('Reconciling float balances against provider balances');
    await this.paymentsService.reconcileFloatBalances();
  }
}
