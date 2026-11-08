import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../config';
import { runInTransaction } from '../../../database/transaction.util';
import {
  ScheduledTransferRejectedError,
  TransfersService,
} from '../../transfers/transfers.service';
import { Money } from '../../../shared/primitives/money';
import {
  SCHEDULED_PAYMENT_PAUSED_EVENT,
  SCHEDULED_PAYMENT_RUN_FAILED_EVENT,
  ScheduledPaymentPausedEventPayload,
  ScheduledPaymentRunFailedEventPayload,
} from '../../../shared/events/domain-events';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { UsersService } from '../../users/users.service';
import { findNextRun, lagosDayEnd, lagosToday } from './run-time';
import { ScheduledPayment } from '../entities/scheduled-payment.entity';
import { ScheduledPaymentRun } from '../entities/scheduled-payment-run.entity';
import { ScheduledPaymentAttempt } from '../entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from '../entities/scheduled-payment-change.entity';
import type { FailureCode } from '../entities/scheduled-payment-attempt.entity';
import { RunJobData, SCHEDULED_PAYMENT_RUNS_QUEUE, runJobId } from './queues';

// A pending first attempt this old with no result is assumed to have lost its
// job.
const STALE_RUN_AFTER_MINUTES = 5;
const MAX_ATTEMPTS = 4;
const RETRY_STEP_MS = 2 * 60 * 60 * 1000;
const CONSECUTIVE_FAILURE_LIMIT = 3;
const PERMANENT_FAILURES: readonly FailureCode[] = [
  'blocked',
  'recipient_unavailable',
  'sender_frozen',
];

interface RunToEnqueue {
  runId: string;
  scheduleId: string;
  runNumber: number;
  attemptNumber: number;
}

// What a recorded attempt means for the sender, published once it commits.
interface RecordedOutcome {
  runFailedReason: FailureCode | null;
  pause: { changeId: string; reason: string } | null;
}

interface AttemptResult {
  outcome: 'succeeded' | 'failed';
  failureCode: FailureCode | null;
  transactionId: string | null;
}

/**
 * The sweep that turns due schedules into runs, and the execution of one run.
 * Internal to the module; the repeatable job and the worker are its callers.
 */
@Injectable()
export class RunEngine {
  private readonly logger = new Logger(RunEngine.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(SCHEDULED_PAYMENT_RUNS_QUEUE)
    private readonly runsQueue: Queue<RunJobData>,
    private readonly transfersService: TransfersService,
    private readonly usersService: UsersService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sweep(): Promise<void> {
    const created = await runInTransaction(this.dataSource, (manager) =>
      this.claimDueSchedules(manager),
    );
    const due = await this.findDuePendingRuns();
    const toEnqueue = [...created, ...due];
    if (toEnqueue.length === 0) {
      return;
    }
    // The run rows are already committed, so a failed enqueue only delays
    // the run until the due-run check picks it up on a later tick.
    try {
      await this.runsQueue.addBulk(
        toEnqueue.map((run) => ({
          name: 'execute-run',
          data: { runId: run.runId },
          opts: {
            jobId: runJobId(run.scheduleId, run.runNumber, run.attemptNumber),
          },
        })),
      );
    } catch (error) {
      this.logger.error(
        `sweep: enqueueing ${toEnqueue.length} run(s) failed (${(error as Error).message}); the due-run check will retry`,
      );
    }
  }

  private async claimDueSchedules(
    manager: EntityManager,
  ): Promise<RunToEnqueue[]> {
    const scheduleRepo = manager.getRepository(ScheduledPayment);
    const due = await scheduleRepo
      .createQueryBuilder('schedule')
      .where(`schedule.status = 'active'`)
      .andWhere('schedule.nextRunAt <= now()')
      .orderBy('schedule.nextRunAt', 'ASC')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();

    const runRepo = manager.getRepository(ScheduledPaymentRun);
    const claimed: RunToEnqueue[] = [];
    for (const schedule of due) {
      const run = await runRepo.save(
        runRepo.create({
          scheduledPaymentId: schedule.id,
          runNumber: schedule.nextRunNumber,
          dueAt: schedule.nextRunAt!,
          status: 'pending',
          amount: schedule.amount,
          targetType: schedule.targetType,
          recipientUserId: schedule.recipientUserId,
          note: schedule.note,
          visibility: schedule.visibility,
        }),
      );
      claimed.push({
        runId: run.id,
        scheduleId: schedule.id,
        runNumber: run.runNumber,
        attemptNumber: 1,
      });
      await this.advance(manager, schedule);
    }
    return claimed;
  }

  // Never completes the schedule: with no next run it stays active and
  // un-dated until its last run ends, so that run can still be cancelled.
  private async advance(
    manager: EntityManager,
    schedule: ScheduledPayment,
  ): Promise<void> {
    schedule.nextRunNumber += 1;
    const runsCreated = await manager
      .getRepository(ScheduledPaymentRun)
      .countBy({ scheduledPaymentId: schedule.id });
    const next = findNextRun(
      schedule,
      runsCreated,
      this.config.scheduledPayments.windowStart,
    );
    schedule.nextRunAt = next?.dueAt ?? null;
    await manager.getRepository(ScheduledPayment).save(schedule);
  }

  // A first attempt is only picked up once its job looks lost; a retry is
  // picked up when it falls due. Enqueueing a run whose job still exists is a
  // no-op because the job id is the same.
  private async findDuePendingRuns(): Promise<RunToEnqueue[]> {
    const rows = await this.dataSource
      .getRepository(ScheduledPaymentRun)
      .createQueryBuilder('run')
      .select('run.id', 'runId')
      .addSelect('run.scheduledPaymentId', 'scheduleId')
      .addSelect('run.runNumber', 'runNumber')
      .addSelect('run.attemptCount + 1', 'attemptNumber')
      .where(`run.status = 'pending'`)
      .andWhere(
        `((run.nextAttemptAt IS NULL AND run.createdAt < now() - make_interval(mins => :minutes)) OR run.nextAttemptAt <= now())`,
        { minutes: STALE_RUN_AFTER_MINUTES },
      )
      .getRawMany<RunToEnqueue>();
    return rows;
  }

  // Posts the run's payment under the current attempt's reference and records
  // the result. The attempt number is only advanced when a result is
  // recorded, so a crash after posting retries under the same reference and
  // finds the original transaction.
  async executeRun(runId: string): Promise<void> {
    const run = await this.dataSource
      .getRepository(ScheduledPaymentRun)
      .findOneBy({ id: runId });
    if (!run || run.status !== 'pending') {
      return;
    }
    // A job can outlive the attempt it was added for, and recovery can add
    // one early; a retry never runs before its time.
    if (run.nextAttemptAt && run.nextAttemptAt > new Date()) {
      return;
    }
    const schedule = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneByOrFail({ id: run.scheduledPaymentId });

    const attemptNumber = run.attemptCount + 1;
    const reference = `sched_${schedule.id}_${run.runNumber}_${attemptNumber}`;
    const startedAt = new Date();

    let result: AttemptResult;
    try {
      const posted = await this.transfersService.executeScheduledTransfer(
        schedule.userId,
        {
          recipientUserId: run.recipientUserId,
          amount: Number(run.amount),
          reference,
          details: { note: run.note, visibility: run.visibility },
          scheduleId: schedule.id,
          runNumber: run.runNumber,
        },
      );
      result = {
        outcome: 'succeeded',
        failureCode: null,
        transactionId: posted.transactionId,
      };
    } catch (error) {
      if (!(error instanceof ScheduledTransferRejectedError)) {
        throw error;
      }
      result = {
        outcome: 'failed',
        failureCode: error.failureCode,
        transactionId: null,
      };
    }
    await this.recordResult(run, schedule.id, {
      attemptNumber,
      reference,
      startedAt,
      result,
    });
  }

  // Called once the queue has given up. The payment may have posted before
  // the fault that kept the attempt from being recorded, so a posted
  // transaction is recorded as the success it is rather than as a failure.
  async recordInfrastructureFailure(runId: string): Promise<void> {
    const run = await this.dataSource
      .getRepository(ScheduledPaymentRun)
      .findOneBy({ id: runId });
    if (!run || run.status !== 'pending') {
      return;
    }
    const schedule = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneByOrFail({ id: run.scheduledPaymentId });
    const attemptNumber = run.attemptCount + 1;
    const reference = `sched_${schedule.id}_${run.runNumber}_${attemptNumber}`;
    const transactionId = await this.transfersService.findTransferIdByReference(
      schedule.userId,
      reference,
    );
    await this.recordResult(run, schedule.id, {
      attemptNumber,
      reference,
      startedAt: new Date(),
      result: transactionId
        ? { outcome: 'succeeded', failureCode: null, transactionId }
        : {
            outcome: 'failed',
            failureCode: 'infrastructure',
            transactionId: null,
          },
    });
  }

  private async recordResult(
    run: ScheduledPaymentRun,
    scheduleId: string,
    attempt: {
      attemptNumber: number;
      reference: string;
      startedAt: Date;
      result: AttemptResult;
    },
  ): Promise<void> {
    const outcome = await runInTransaction(this.dataSource, (manager) =>
      this.recordResultInTransaction(manager, run, scheduleId, attempt),
    );
    if (outcome.runFailedReason || outcome.pause) {
      await this.publishOutcome(run, scheduleId, outcome);
    }
  }

  private async recordResultInTransaction(
    manager: EntityManager,
    run: ScheduledPaymentRun,
    scheduleId: string,
    attempt: {
      attemptNumber: number;
      reference: string;
      startedAt: Date;
      result: AttemptResult;
    },
  ): Promise<RecordedOutcome> {
    const { result } = attempt;
    const outcome: RecordedOutcome = { runFailedReason: null, pause: null };

    // Locked so a cancel, a pause and the end of this run can't each move
    // the schedule's status.
    const schedule = await manager
      .getRepository(ScheduledPayment)
      .createQueryBuilder('schedule')
      .where('schedule.id = :scheduleId', { scheduleId })
      .setLock('pessimistic_write')
      .getOneOrFail();

    await manager.getRepository(ScheduledPaymentAttempt).save({
      runId: run.id,
      kind: 'attempt',
      attemptNumber: attempt.attemptNumber,
      reference: attempt.reference,
      outcome: result.outcome,
      failureCode: result.failureCode,
      transactionId: result.transactionId,
      startedAt: attempt.startedAt,
    });

    const nextAttemptAt =
      result.outcome === 'failed'
        ? await this.nextAttemptTime(manager, run, attempt)
        : null;
    const status =
      result.outcome === 'succeeded'
        ? 'succeeded'
        : nextAttemptAt
          ? 'pending'
          : 'failed';

    // A cancel or pause that landed while the attempt was executing leaves
    // the run `cancelled`; money that did move is still recorded as succeeded.
    const runRepo = manager.getRepository(ScheduledPaymentRun);
    const updated = await runRepo
      .createQueryBuilder()
      .update()
      .set({
        status,
        attemptCount: attempt.attemptNumber,
        transactionId: result.transactionId,
        nextAttemptAt,
      })
      .where('id = :id', { id: run.id })
      .andWhere(
        result.outcome === 'succeeded'
          ? `status IN ('pending', 'cancelled')`
          : `status = 'pending'`,
      )
      .execute();
    if (!updated.affected) {
      return outcome;
    }

    if (status === 'succeeded') {
      schedule.consecutiveFailures = 0;
    } else if (status === 'failed') {
      schedule.consecutiveFailures += 1;
      outcome.runFailedReason = result.failureCode;
      const pauseReason = PERMANENT_FAILURES.includes(result.failureCode!)
        ? result.failureCode
        : schedule.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT
          ? 'consecutive_failures'
          : null;
      // With no run left to start, the schedule just completes below.
      if (
        pauseReason &&
        schedule.status === 'active' &&
        schedule.nextRunAt !== null
      ) {
        schedule.status = 'paused';
        schedule.pausedReason = pauseReason;
        schedule.nextRunAt = null;
        const change = await manager
          .getRepository(ScheduledPaymentChange)
          .save({
            scheduledPaymentId: schedule.id,
            kind: 'paused',
            actor: 'system',
            reason: pauseReason,
          });
        outcome.pause = { changeId: change.id, reason: pauseReason };
      }
    }

    const pendingRuns = await runRepo.countBy({
      scheduledPaymentId: schedule.id,
      status: 'pending',
    });
    if (
      schedule.status === 'active' &&
      schedule.nextRunAt === null &&
      pendingRuns === 0
    ) {
      schedule.status = 'completed';
      await manager.getRepository(ScheduledPaymentChange).save({
        scheduledPaymentId: schedule.id,
        kind: 'completed',
        actor: 'system',
      });
    }
    await manager.getRepository(ScheduledPayment).save(schedule);
    return outcome;
  }

  // Retries run 2h, 4h and 6h after the first attempt, and only within the
  // Lagos day of the run's date: a payment that slipped past midnight would
  // count against the next day's limit.
  private async nextAttemptTime(
    manager: EntityManager,
    run: ScheduledPaymentRun,
    attempt: { attemptNumber: number; startedAt: Date; result: AttemptResult },
  ): Promise<Date | null> {
    const failureCode = attempt.result.failureCode;
    if (
      !failureCode ||
      PERMANENT_FAILURES.includes(failureCode) ||
      attempt.attemptNumber >= MAX_ATTEMPTS
    ) {
      return null;
    }
    const firstStartedAt =
      attempt.attemptNumber === 1
        ? attempt.startedAt
        : (
            await manager
              .getRepository(ScheduledPaymentAttempt)
              .findOneByOrFail({ runId: run.id, attemptNumber: 1 })
          ).startedAt;
    const next = new Date(
      firstStartedAt.getTime() + attempt.attemptNumber * RETRY_STEP_MS,
    );
    return next < lagosDayEnd(lagosToday(run.dueAt)) ? next : null;
  }

  private async publishOutcome(
    run: ScheduledPaymentRun,
    scheduleId: string,
    outcome: RecordedOutcome,
  ): Promise<void> {
    try {
      const schedule = await this.dataSource
        .getRepository(ScheduledPayment)
        .findOneByOrFail({ id: scheduleId });
      const [sender, recipient] = await Promise.all([
        this.usersService.findById(schedule.userId),
        this.usersService.findById(run.recipientUserId),
      ]);
      const amount = Money.of(run.amount, schedule.currency).toDecimalString();
      if (outcome.runFailedReason) {
        await this.eventBus.publish<
          string,
          ScheduledPaymentRunFailedEventPayload
        >({
          name: SCHEDULED_PAYMENT_RUN_FAILED_EVENT,
          payload: {
            userId: schedule.userId,
            scheduledPaymentId: schedule.id,
            runId: run.id,
            counterpartyUsername: recipient.username,
            amount,
            currency: schedule.currency,
            runDate: lagosToday(run.dueAt),
            reason: outcome.runFailedReason,
          },
          occurredAt: new Date(),
        });
      }
      if (outcome.pause) {
        await this.eventBus.publish<string, ScheduledPaymentPausedEventPayload>(
          {
            name: SCHEDULED_PAYMENT_PAUSED_EVENT,
            payload: {
              userId: schedule.userId,
              email: sender.email,
              scheduledPaymentId: schedule.id,
              changeId: outcome.pause.changeId,
              counterpartyUsername: recipient.username,
              amount,
              currency: schedule.currency,
              reason: outcome.pause.reason,
            },
            occurredAt: new Date(),
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `run ${run.id} ended, but publishing its notifications failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
