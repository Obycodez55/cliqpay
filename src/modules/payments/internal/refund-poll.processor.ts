import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PaymentsService } from '../payments.service';

// Its own queue and schedule, like FUNDING_POLL_QUEUE and
// WITHDRAWAL_POLL_QUEUE: one fixed recurring maintenance job, not domain-event
// traffic.
export const REFUND_POLL_QUEUE = 'refund-poll';
const REFUND_POLL_JOB_NAME = 'poll-stale-refunds';
const REFUND_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Recovers refunds of held fundings (docs/adr/0021): resolves attempts whose
 * webhook never arrived, starts the next attempt after a failure, and alerts
 * operations when held money is not getting resolved.
 */
@Processor(REFUND_POLL_QUEUE)
export class RefundPollProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RefundPollProcessor.name);

  constructor(
    @InjectQueue(REFUND_POLL_QUEUE) private readonly queue: Queue,
    private readonly paymentsService: PaymentsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      REFUND_POLL_JOB_NAME,
      { every: REFUND_POLL_INTERVAL_MS },
      { name: REFUND_POLL_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    this.logger.debug('Polling held fundings and pending refunds');
    await this.paymentsService.pollStaleRefundTransactions();
  }
}
