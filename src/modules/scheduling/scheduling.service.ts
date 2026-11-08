import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { Money } from '../../shared/primitives/money';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import {
  SCHEDULED_PAYMENT_CREATED_EVENT,
  SCHEDULED_PAYMENT_UPDATED_EVENT,
  ScheduledPaymentCreatedEventPayload,
  ScheduledPaymentUpdatedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuthService } from '../auth/auth.service';
import { KycService } from '../kyc/kyc.service';
import { SocialService } from '../social/social.service';
import { TransfersService } from '../transfers/transfers.service';
import { UsersService } from '../users/users.service';
import { CreateScheduledPaymentDto } from './dto/create-scheduled-payment.dto';
import { ListScheduledPaymentRunsQueryDto } from './dto/list-scheduled-payment-runs-query.dto';
import { ListScheduledPaymentsQueryDto } from './dto/list-scheduled-payments-query.dto';
import { ResumeScheduledPaymentDto } from './dto/resume-scheduled-payment.dto';
import { UpdateScheduledPaymentDto } from './dto/update-scheduled-payment.dto';
import { ScheduledPaymentRunResponseDto } from './dto/scheduled-payment-run-response.dto';
import { ScheduledPaymentResponseDto } from './dto/scheduled-payment-response.dto';
import { ScheduledPayment } from './entities/scheduled-payment.entity';
import { ScheduledPaymentRun } from './entities/scheduled-payment-run.entity';
import { ScheduledPaymentAttempt } from './entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from './entities/scheduled-payment-change.entity';
import {
  ScheduleAlreadyCompletedException,
  ScheduleAmountExceedsDailyLimitException,
  ScheduleLimitReachedException,
  ScheduleNothingToResumeException,
  SchedulePinRequiredException,
  ScheduleRecurrenceInvalidException,
  ScheduleRecipientUnableToReceiveException,
  ScheduleReferenceReusedException,
  ScheduleSenderFrozenException,
  ScheduleStatusConflictException,
  ScheduleStartDateInvalidException,
  ScheduledPaymentNotFoundException,
} from './internal/errors';
import {
  computeDueAt,
  findNextRun,
  isValidIsoDate,
  lagosToday,
  startDateBounds,
} from './internal/run-time';
import { RunEngine } from './internal/run-engine.service';
import { needsPin, pinGatedChanged, planEdit } from './internal/schedule-edit';

const NGN = 'NGN';
const UNIQUE_REFERENCE = 'UQ_scheduled_payments_user_id_reference';
// Both mean the recipient can't take the money; neither is told to the sender
// as such, so a recipient's tier or balance isn't revealed.
const RECIPIENT_CAP_ERROR_CODES = [
  'BALANCE_CAP_EXCEEDED',
  'KYC_VERIFICATION_REQUIRED',
];

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    // @InjectDataSource: creation and cancellation each write several rows
    // under a lock in one transaction.
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transfersService: TransfersService,
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
    private readonly socialService: SocialService,
    private readonly authService: AuthService,
    private readonly eventBus: EventBusService,
    private readonly runEngine: RunEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    userId: string,
    dto: CreateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    const replayed = await this.findReplay(userId, dto);
    if (replayed) {
      return this.respond(replayed);
    }

    const recipientUserId = dto.target.userId;
    const { min, max } = startDateBounds(new Date());
    if (
      !isValidIsoDate(dto.startDate) ||
      dto.startDate < min ||
      dto.startDate > max
    ) {
      throw new ScheduleStartDateInvalidException(min, max);
    }
    assertRecurrenceValid(dto);

    const prepared = await this.transfersService.prepareTransfer(
      userId,
      recipientUserId,
      dto.amount,
    );
    if (prepared.sender.isFrozen) {
      throw new ScheduleSenderFrozenException();
    }
    await this.assertWithinDailyLimit(userId, prepared.amount);
    await this.assertRecipientCanReceive(userId, prepared);
    await this.authService.verifyTransactionPin(userId, dto.pin);

    const { windowStart, windowMinutes } = this.config.scheduledPayments;
    const runOffsetMinutes = Math.floor(Math.random() * windowMinutes);

    let schedule: ScheduledPayment;
    try {
      schedule = await runInTransaction(this.dataSource, async (manager) => {
        await this.lockUserSchedules(manager, userId);
        await this.assertUnderActiveLimit(manager, userId);
        const repo = manager.getRepository(ScheduledPayment);
        const created = await repo.save(
          repo.create({
            userId,
            reference: dto.reference,
            targetType: 'user',
            recipientUserId,
            amount: prepared.amount.amount,
            currency: NGN,
            note: dto.note ?? null,
            visibility: dto.visibility,
            startDate: dto.startDate,
            anchorRunNumber: 1,
            intervalUnit: dto.interval?.unit ?? null,
            intervalCount: dto.interval?.count ?? null,
            endDate: dto.endDate ?? null,
            maxRuns: dto.maxRuns ?? null,
            runOffsetMinutes,
            status: 'active',
            nextRunNumber: 1,
            nextRunAt: computeDueAt(
              dto.startDate,
              windowStart,
              runOffsetMinutes,
            ),
          }),
        );
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: created.id,
          kind: 'created',
          actor: 'user',
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, UNIQUE_REFERENCE)) {
        const raced = await this.findReplay(userId, dto);
        if (raced) {
          return this.respond(raced);
        }
      }
      throw error;
    }

    await this.publishCreated(schedule, prepared.sender.email);
    return toResponse(schedule, 0);
  }

  async get(
    userId: string,
    scheduleId: string,
  ): Promise<ScheduledPaymentResponseDto> {
    const schedule = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneBy({ id: scheduleId, userId });
    if (!schedule) {
      throw new ScheduledPaymentNotFoundException();
    }
    return this.respond(schedule);
  }

  async list(
    userId: string,
    query: ListScheduledPaymentsQueryDto,
  ): Promise<PaginatedResult<ScheduledPaymentResponseDto>> {
    const cursor = query.cursor ? decodeCreatedAtIdCursor(query.cursor) : null;
    const builder = this.dataSource
      .getRepository(ScheduledPayment)
      .createQueryBuilder('schedule')
      // Compared on Postgres's own text form of created_at, not the
      // millisecond JS Date, so rows sharing a millisecond aren't skipped at
      // a page boundary.
      .addSelect('"schedule"."created_at"::text', 'raw_created_at')
      .where('schedule.userId = :userId', { userId })
      .orderBy('schedule.createdAt', 'DESC')
      .addOrderBy('schedule.id', 'DESC')
      .take(query.limit + 1);
    if (query.status === 'active') {
      builder.andWhere(`schedule.status = 'active'`);
    } else if (query.status === 'paused') {
      builder.andWhere(`schedule.status = 'paused'`);
    } else if (query.status === 'ended') {
      builder.andWhere(`schedule.status IN ('cancelled', 'completed')`);
    }
    if (cursor) {
      builder.andWhere(
        '(schedule.createdAt, schedule.id) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }
    const { entities, raw } = await builder.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > query.limit;
    const page = hasMore ? entities.slice(0, query.limit) : entities;
    const runsUsed = await this.runsCreated(page.map((s) => s.id));
    return {
      items: page.map((schedule) =>
        toResponse(schedule, runsUsed.get(schedule.id) ?? 0),
      ),
      nextCursor: hasMore
        ? encodeCreatedAtIdCursor({
            createdAt: raw[query.limit - 1].raw_created_at,
            id: page[page.length - 1].id,
          })
        : null,
    };
  }

  async cancel(
    userId: string,
    scheduleId: string,
  ): Promise<ScheduledPaymentResponseDto> {
    const schedule = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const repo = manager.getRepository(ScheduledPayment);
        const locked = await repo
          .createQueryBuilder('schedule')
          .where('schedule.id = :scheduleId', { scheduleId })
          .andWhere('schedule.userId = :userId', { userId })
          .setLock('pessimistic_write')
          .getOne();
        if (!locked) {
          throw new ScheduledPaymentNotFoundException();
        }
        if (locked.status === 'cancelled') {
          return locked;
        }
        if (locked.status === 'completed') {
          throw new ScheduleAlreadyCompletedException();
        }
        locked.status = 'cancelled';
        locked.nextRunAt = null;
        await repo.save(locked);
        await manager
          .getRepository(ScheduledPaymentRun)
          .update(
            { scheduledPaymentId: locked.id, status: 'pending' },
            { status: 'cancelled', nextAttemptAt: null },
          );
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: locked.id,
          kind: 'cancelled',
          actor: 'user',
        });
        return locked;
      },
    );
    return this.respond(schedule);
  }

  async pause(
    userId: string,
    scheduleId: string,
  ): Promise<ScheduledPaymentResponseDto> {
    const schedule = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockOwned(manager, userId, scheduleId);
        if (locked.status === 'paused') {
          return locked;
        }
        if (locked.status !== 'active') {
          throw new ScheduleStatusConflictException(
            `A ${locked.status} scheduled payment cannot be paused`,
          );
        }
        locked.status = 'paused';
        locked.pausedReason = 'user';
        locked.nextRunAt = null;
        await manager.getRepository(ScheduledPayment).save(locked);
        // Stopping money is immediate: an attempt already executing
        // finishes, but nothing waiting to start does.
        await manager
          .getRepository(ScheduledPaymentRun)
          .update(
            { scheduledPaymentId: locked.id, status: 'pending' },
            { status: 'cancelled', nextAttemptAt: null },
          );
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: locked.id,
          kind: 'paused',
          actor: 'user',
          reason: 'user',
        });
        return locked;
      },
    );
    return this.respond(schedule);
  }

  async resume(
    userId: string,
    scheduleId: string,
    dto: ResumeScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    const current = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneBy({ id: scheduleId, userId });
    if (!current) {
      throw new ScheduledPaymentNotFoundException();
    }
    assertPaused(current);
    // Checked before the PIN so a schedule with nothing left doesn't cost an
    // attempt at it.
    this.requireNextRun(
      current,
      (await this.runsCreated([current.id])).get(current.id) ?? 0,
    );
    await this.authService.verifyTransactionPin(userId, dto.pin);

    const schedule = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockOwned(manager, userId, scheduleId);
        assertPaused(locked);
        const runsCreated =
          (await this.runsCreated([locked.id], manager)).get(locked.id) ?? 0;
        const next = this.requireNextRun(locked, runsCreated);
        // Dates that passed while paused are skipped, not run; the anchor stays
        // so a 31st-of-the-month schedule keeps its day.
        locked.nextRunNumber = next.runNumber;
        locked.nextRunAt = next.dueAt;
        locked.status = 'active';
        locked.pausedReason = null;
        locked.consecutiveFailures = 0;
        await manager.getRepository(ScheduledPayment).save(locked);
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: locked.id,
          kind: 'resumed',
          actor: 'user',
        });
        return locked;
      },
    );
    return this.respond(schedule);
  }

  async update(
    userId: string,
    scheduleId: string,
    dto: UpdateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    const { windowStart } = this.config.scheduledPayments;
    const current = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneBy({ id: scheduleId, userId });
    if (!current) {
      throw new ScheduledPaymentNotFoundException();
    }
    assertEditable(current);
    const pinNeeded = needsPin(dto);
    if (pinNeeded && dto.pin === undefined) {
      throw new SchedulePinRequiredException();
    }

    // Everything is validated before the PIN is checked, so an invalid edit
    // doesn't cost an attempt at it.
    const preview = planEdit(
      current,
      (await this.runsCreated([current.id])).get(current.id) ?? 0,
      dto,
      new Date(),
      windowStart,
    );
    if (preview.changes.amount) {
      await this.assertAmountAllowed(
        userId,
        current.recipientUserId,
        dto.amount!,
      );
    }
    if (pinNeeded) {
      await this.authService.verifyTransactionPin(userId, dto.pin!);
    }

    const result = await runInTransaction(this.dataSource, async (manager) => {
      const locked = await this.lockOwned(manager, userId, scheduleId);
      assertEditable(locked);
      const runsCreated =
        (await this.runsCreated([locked.id], manager)).get(locked.id) ?? 0;
      const plan = planEdit(locked, runsCreated, dto, new Date(), windowStart);
      if (Object.keys(plan.changes).length === 0) {
        return { schedule: locked, plan, changeId: null };
      }
      Object.assign(locked, plan.values);
      const change = await manager.getRepository(ScheduledPaymentChange).save({
        scheduledPaymentId: locked.id,
        kind: 'updated',
        actor: 'user',
        changes: plan.changes,
      });
      if (locked.status === 'active' && locked.nextRunAt === null) {
        await this.runEngine.completeIfFinished(manager, locked);
      }
      await manager.getRepository(ScheduledPayment).save(locked);
      return { schedule: locked, plan, changeId: change.id };
    });

    if (result.changeId && pinGatedChanged(result.plan)) {
      await this.publishUpdated(
        result.schedule,
        result.changeId,
        Object.keys(result.plan.changes),
      );
    }
    return this.respond(result.schedule);
  }

  async listRuns(
    userId: string,
    scheduleId: string,
    query: ListScheduledPaymentRunsQueryDto,
  ): Promise<PaginatedResult<ScheduledPaymentRunResponseDto>> {
    const owned = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOne({ where: { id: scheduleId, userId }, select: { id: true } });
    if (!owned) {
      throw new ScheduledPaymentNotFoundException();
    }
    const before = query.cursor ? decodeRunNumberCursor(query.cursor) : null;
    const builder = this.dataSource
      .getRepository(ScheduledPaymentRun)
      .createQueryBuilder('run')
      .where('run.scheduledPaymentId = :scheduleId', { scheduleId })
      .orderBy('run.runNumber', 'DESC')
      .take(query.limit + 1);
    if (before !== null) {
      builder.andWhere('run.runNumber < :before', { before });
    }
    const runs = await builder.getMany();
    const hasMore = runs.length > query.limit;
    const page = hasMore ? runs.slice(0, query.limit) : runs;
    const attempts = page.length
      ? await this.dataSource.getRepository(ScheduledPaymentAttempt).find({
          where: { runId: In(page.map((run) => run.id)) },
          order: { attemptNumber: 'ASC' },
        })
      : [];
    return {
      items: page.map((run) => ({
        id: run.id,
        runNumber: run.runNumber,
        dueDate: lagosToday(run.dueAt),
        status: run.status,
        amount: Money.of(run.amount, NGN).toJSON(),
        nextAttemptAt: run.nextAttemptAt?.toISOString() ?? null,
        transactionId: run.transactionId,
        attempts: attempts
          .filter((attempt) => attempt.runId === run.id)
          .map((attempt) => ({
            kind: attempt.kind,
            attemptNumber: attempt.attemptNumber,
            outcome: attempt.outcome,
            failureCode: attempt.failureCode,
            transactionId: attempt.transactionId,
            startedAt: attempt.startedAt?.toISOString() ?? null,
          })),
      })),
      nextCursor: hasMore
        ? encodeRunNumberCursor(page[page.length - 1].runNumber)
        : null,
    };
  }

  private async lockOwned(
    manager: EntityManager,
    userId: string,
    scheduleId: string,
  ): Promise<ScheduledPayment> {
    const locked = await manager
      .getRepository(ScheduledPayment)
      .createQueryBuilder('schedule')
      .where('schedule.id = :scheduleId', { scheduleId })
      .andWhere('schedule.userId = :userId', { userId })
      .setLock('pessimistic_write')
      .getOne();
    if (!locked) {
      throw new ScheduledPaymentNotFoundException();
    }
    return locked;
  }

  private requireNextRun(
    schedule: ScheduledPayment,
    runsCreated: number,
  ): { runNumber: number; dueAt: Date } {
    const next = findNextRun(
      schedule,
      runsCreated,
      this.config.scheduledPayments.windowStart,
      new Date(),
    );
    if (!next) {
      throw new ScheduleNothingToResumeException();
    }
    return next;
  }

  private async runsCreated(
    scheduleIds: string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<string, number>> {
    if (scheduleIds.length === 0) {
      return new Map();
    }
    const rows = await manager
      .getRepository(ScheduledPaymentRun)
      .createQueryBuilder('run')
      .select('run.scheduledPaymentId', 'scheduleId')
      .addSelect('count(*)', 'count')
      .where('run.scheduledPaymentId IN (:...scheduleIds)', { scheduleIds })
      .groupBy('run.scheduledPaymentId')
      .getRawMany<{ scheduleId: string; count: string }>();
    return new Map(rows.map((row) => [row.scheduleId, Number(row.count)]));
  }

  private async respond(
    schedule: ScheduledPayment,
  ): Promise<ScheduledPaymentResponseDto> {
    const runsUsed = await this.runsCreated([schedule.id]);
    return toResponse(schedule, runsUsed.get(schedule.id) ?? 0);
  }

  private async findReplay(
    userId: string,
    dto: CreateScheduledPaymentDto,
  ): Promise<ScheduledPayment | null> {
    const existing = await this.dataSource
      .getRepository(ScheduledPayment)
      .findOneBy({ userId, reference: dto.reference });
    if (!existing) {
      return null;
    }
    const same =
      existing.recipientUserId === dto.target.userId &&
      existing.amount === BigInt(dto.amount) &&
      existing.startDate === dto.startDate &&
      existing.intervalUnit === (dto.interval?.unit ?? null) &&
      existing.intervalCount === (dto.interval?.count ?? null) &&
      existing.endDate === (dto.endDate ?? null) &&
      existing.maxRuns === (dto.maxRuns ?? null) &&
      existing.note === (dto.note ?? null) &&
      existing.visibility === dto.visibility;
    if (!same) {
      throw new ScheduleReferenceReusedException();
    }
    return existing;
  }

  private async assertAmountAllowed(
    userId: string,
    recipientUserId: string,
    amount: number,
  ): Promise<void> {
    const prepared = await this.transfersService.prepareTransfer(
      userId,
      recipientUserId,
      amount,
    );
    if (prepared.sender.isFrozen) {
      throw new ScheduleSenderFrozenException();
    }
    await this.assertWithinDailyLimit(userId, prepared.amount);
    await this.assertRecipientCanReceive(userId, prepared);
  }

  private async assertWithinDailyLimit(
    userId: string,
    amount: Money,
  ): Promise<void> {
    const dailyLimit = await this.kycService.requireDailyLimit(
      this.dataSource.manager,
      userId,
      NGN,
    );
    if (amount.greaterThan(dailyLimit)) {
      throw new ScheduleAmountExceedsDailyLimitException(
        dailyLimit.toDecimalString(),
      );
    }
  }

  // Advisory only: by the run date the recipient's wallet, tier or blocks
  // may have changed, and the run itself checks all of it again.
  private async assertRecipientCanReceive(
    userId: string,
    prepared: Awaited<ReturnType<TransfersService['prepareTransfer']>>,
  ): Promise<void> {
    if (
      await this.socialService.isBlockedBetween(
        userId,
        prepared.recipientUserId,
      )
    ) {
      throw new ScheduleRecipientUnableToReceiveException();
    }
    try {
      await this.kycService.checkCanReceive(
        this.dataSource.manager,
        prepared.recipientUserId,
        prepared.amount,
        () =>
          Promise.resolve({
            balance: Money.of(
              prepared.recipientWallet.balance,
              prepared.recipientWallet.currency,
            ),
            pending: Money.zero(NGN),
          }),
      );
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code && RECIPIENT_CAP_ERROR_CODES.includes(code)) {
        throw new ScheduleRecipientUnableToReceiveException();
      }
      throw error;
    }
  }

  // Counting then inserting is a check-then-act, so two concurrent creates
  // from one user are serialised on an advisory lock.
  private async lockUserSchedules(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`scheduled_payments:${userId}`],
    );
  }

  private async assertUnderActiveLimit(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const { maxActive } = this.config.scheduledPayments;
    const active = await manager
      .getRepository(ScheduledPayment)
      .countBy({ userId, status: In(['active', 'paused']) });
    if (active >= maxActive) {
      throw new ScheduleLimitReachedException(maxActive);
    }
  }

  private async publishCreated(
    schedule: ScheduledPayment,
    senderEmail: string,
  ): Promise<void> {
    try {
      const recipient = await this.usersService.findById(
        schedule.recipientUserId,
      );
      await this.eventBus.publish<string, ScheduledPaymentCreatedEventPayload>({
        name: SCHEDULED_PAYMENT_CREATED_EVENT,
        payload: {
          userId: schedule.userId,
          email: senderEmail,
          scheduledPaymentId: schedule.id,
          counterpartyUsername: recipient.username,
          amount: Money.of(
            schedule.amount,
            schedule.currency,
          ).toDecimalString(),
          currency: schedule.currency,
          startDate: schedule.startDate,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `create: scheduled payment "${schedule.id}" created, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishUpdated(
    schedule: ScheduledPayment,
    changeId: string,
    changedFields: string[],
  ): Promise<void> {
    try {
      const [sender, recipient] = await Promise.all([
        this.usersService.findById(schedule.userId),
        this.usersService.findById(schedule.recipientUserId),
      ]);
      await this.eventBus.publish<string, ScheduledPaymentUpdatedEventPayload>({
        name: SCHEDULED_PAYMENT_UPDATED_EVENT,
        payload: {
          userId: schedule.userId,
          email: sender.email,
          scheduledPaymentId: schedule.id,
          changeId,
          counterpartyUsername: recipient.username,
          amount: Money.of(
            schedule.amount,
            schedule.currency,
          ).toDecimalString(),
          currency: schedule.currency,
          changedFields,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `update: scheduled payment "${schedule.id}" updated, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

function assertEditable(schedule: ScheduledPayment): void {
  if (schedule.status === 'cancelled' || schedule.status === 'completed') {
    throw new ScheduleStatusConflictException(
      `A ${schedule.status} scheduled payment cannot be edited`,
    );
  }
}

function assertRecurrenceValid(dto: CreateScheduledPaymentDto): void {
  if (!dto.interval) {
    if (dto.endDate !== undefined || dto.maxRuns !== undefined) {
      throw new ScheduleRecurrenceInvalidException(
        'endDate and maxRuns need an interval',
      );
    }
    return;
  }
  if (dto.endDate !== undefined && dto.maxRuns !== undefined) {
    throw new ScheduleRecurrenceInvalidException(
      'Set at most one of endDate and maxRuns',
    );
  }
  if (
    dto.endDate !== undefined &&
    (!isValidIsoDate(dto.endDate) || dto.endDate < dto.startDate)
  ) {
    throw new ScheduleRecurrenceInvalidException(
      'endDate must be a real date on or after startDate',
    );
  }
}

function assertPaused(schedule: ScheduledPayment): void {
  if (schedule.status !== 'paused') {
    throw new ScheduleStatusConflictException(
      `Only a paused scheduled payment can be resumed; this one is ${schedule.status}`,
    );
  }
}

function encodeRunNumberCursor(runNumber: number): string {
  return Buffer.from(JSON.stringify({ runNumber })).toString('base64url');
}

function decodeRunNumberCursor(raw: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as { runNumber?: unknown } | null;
    const runNumber = parsed?.runNumber;
    if (
      typeof runNumber === 'number' &&
      Number.isInteger(runNumber) &&
      runNumber > 0
    ) {
      return runNumber;
    }
  } catch {
    // falls through to the 400 below
  }
  throw new BadRequestException('Invalid cursor');
}

function toResponse(
  schedule: ScheduledPayment,
  runsUsed: number,
): ScheduledPaymentResponseDto {
  return {
    id: schedule.id,
    target: { type: 'user', userId: schedule.recipientUserId },
    amount: Money.of(schedule.amount, schedule.currency).toJSON(),
    note: schedule.note,
    visibility: schedule.visibility,
    interval:
      schedule.intervalUnit && schedule.intervalCount
        ? { unit: schedule.intervalUnit, count: schedule.intervalCount }
        : null,
    endDate: schedule.endDate,
    maxRuns: schedule.maxRuns,
    runsUsed,
    status: schedule.status,
    consecutiveFailures: schedule.consecutiveFailures,
    pausedReason: schedule.pausedReason,
    nextRunDate: schedule.nextRunAt ? lagosToday(schedule.nextRunAt) : null,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
  };
}
