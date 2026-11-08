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
import { computeDueAt, runDate } from './run-time';
import { ScheduledPayment } from '../entities/scheduled-payment.entity';
import { ScheduledPaymentRun } from '../entities/scheduled-payment-run.entity';
import { ScheduledPaymentAttempt } from '../entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from '../entities/scheduled-payment-change.entity';
import type { FailureCode } from '../entities/scheduled-payment-attempt.entity';
import { RunJobData, SCHEDULED_PAYMENT_RUNS_QUEUE, runJobId } from './queues';

// A pending run this old with no result is assumed to have lost its job.
const STALE_RUN_AFTER_MINUTES = 5;

interface RunToEnqueue {
  runId: string;
  scheduleId: string;
  runNumber: number;
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sweep(): Promise<void> {
    const created = await runInTransaction(this.dataSource, (manager) =>
      this.claimDueSchedules(manager),
    );
    const stale = await this.findStalePendingRuns();
    const toEnqueue = [...created, ...stale];
    if (toEnqueue.length === 0) {
      return;
    }
    // The run rows are already committed, so a failed enqueue only delays
    // the run until the stale check picks it up on a later tick.
    try {
      await this.runsQueue.addBulk(
        toEnqueue.map((run) => ({
          name: 'execute-run',
          data: { runId: run.runId },
          opts: { jobId: runJobId(run.scheduleId, run.runNumber) },
        })),
      );
    } catch (error) {
      this.logger.error(
        `sweep: enqueueing ${toEnqueue.length} run(s) failed (${(error as Error).message}); the stale-run check will retry`,
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
    schedule.nextRunAt = null;
    if (schedule.intervalUnit && schedule.intervalCount) {
      const nextDate = runDate(
        schedule.startDate,
        schedule.anchorRunNumber,
        { unit: schedule.intervalUnit, count: schedule.intervalCount },
        schedule.nextRunNumber,
      );
      const exhausted =
        (schedule.maxRuns !== null &&
          schedule.nextRunNumber > schedule.maxRuns) ||
        (schedule.endDate !== null && nextDate > schedule.endDate);
      if (!exhausted) {
        schedule.nextRunAt = computeDueAt(
          nextDate,
          this.config.scheduledPayments.windowStart,
          schedule.runOffsetMinutes,
        );
      }
    }
    await manager.getRepository(ScheduledPayment).save(schedule);
  }

  private async findStalePendingRuns(): Promise<RunToEnqueue[]> {
    const rows = await this.dataSource
      .getRepository(ScheduledPaymentRun)
      .createQueryBuilder('run')
      .select('run.id', 'runId')
      .addSelect('run.scheduledPaymentId', 'scheduleId')
      .addSelect('run.runNumber', 'runNumber')
      .where(`run.status = 'pending'`)
      .andWhere(`run.createdAt < now() - make_interval(mins => :minutes)`, {
        minutes: STALE_RUN_AFTER_MINUTES,
      })
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
    const { result } = attempt;
    await runInTransaction(this.dataSource, async (manager) => {
      // Locked so a cancel and the end of this run can't both move the
      // schedule's status.
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

      // A cancel that landed while the attempt was executing leaves the run
      // `cancelled`; money that did move is still recorded as succeeded.
      const runRepo = manager.getRepository(ScheduledPaymentRun);
      await runRepo
        .createQueryBuilder()
        .update()
        .set({
          status: result.outcome,
          attemptCount: attempt.attemptNumber,
          transactionId: result.transactionId,
        })
        .where('id = :id', { id: run.id })
        .andWhere(
          result.outcome === 'succeeded'
            ? `status IN ('pending', 'cancelled')`
            : `status = 'pending'`,
        )
        .execute();

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
        await manager.getRepository(ScheduledPayment).save(schedule);
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: schedule.id,
          kind: 'completed',
          actor: 'system',
        });
      }
    });
  }
}
