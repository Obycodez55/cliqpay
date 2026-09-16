import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PaymentsService } from '../payments.service';

// Its own queue and schedule, independent of FUNDING_POLL_QUEUE — same
// reasoning as that queue's own comment (see funding-poll.processor.ts):
// this is a single fixed recurring maintenance job, not domain-event
// traffic, and mirrors a different transaction type on its own schedule.
export const WITHDRAWAL_POLL_QUEUE = 'withdrawal-poll';
const WITHDRAWAL_POLL_JOB_NAME = 'poll-stale-withdrawal';
const WITHDRAWAL_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Issue #31 — the withdrawal equivalent of FundingPollProcessor (#14):
 * recovers a withdrawal left `pending` because Kora's payout webhook never
 * arrived. Same `upsertJobScheduler` recurring-job shape; nothing else ever
 * adds a job to this queue.
 */
@Processor(WITHDRAWAL_POLL_QUEUE)
export class WithdrawalPollProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(WithdrawalPollProcessor.name);

  constructor(
    @InjectQueue(WITHDRAWAL_POLL_QUEUE) private readonly queue: Queue,
    private readonly paymentsService: PaymentsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      WITHDRAWAL_POLL_JOB_NAME,
      { every: WITHDRAWAL_POLL_INTERVAL_MS },
      { name: WITHDRAWAL_POLL_JOB_NAME },
    );
  }

  async process(_job: Job): Promise<void> {
    this.logger.debug('Polling stale withdrawal transactions');
    await this.paymentsService.pollStaleWithdrawalTransactions();
  }
}
