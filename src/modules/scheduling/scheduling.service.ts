import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { Money } from '../../shared/primitives/money';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import {
  SCHEDULED_PAYMENT_CREATED_EVENT,
  ScheduledPaymentCreatedEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuthService } from '../auth/auth.service';
import { KycService } from '../kyc/kyc.service';
import { SocialService } from '../social/social.service';
import { TransfersService } from '../transfers/transfers.service';
import { UsersService } from '../users/users.service';
import { CreateScheduledPaymentDto } from './dto/create-scheduled-payment.dto';
import { ScheduledPaymentResponseDto } from './dto/scheduled-payment-response.dto';
import { ScheduledPayment } from './entities/scheduled-payment.entity';
import { ScheduledPaymentRun } from './entities/scheduled-payment-run.entity';
import { ScheduledPaymentChange } from './entities/scheduled-payment-change.entity';
import {
  ScheduleAlreadyCompletedException,
  ScheduleAmountExceedsDailyLimitException,
  ScheduleLimitReachedException,
  ScheduleRecipientUnableToReceiveException,
  ScheduleReferenceReusedException,
  ScheduleSenderFrozenException,
  ScheduleStartDateInvalidException,
  ScheduledPaymentNotFoundException,
} from './internal/errors';
import {
  computeDueAt,
  isValidIsoDate,
  lagosToday,
  startDateBounds,
} from './internal/run-time';

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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    userId: string,
    dto: CreateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    const replayed = await this.findReplay(userId, dto);
    if (replayed) {
      return toResponse(replayed);
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
          return toResponse(raced);
        }
      }
      throw error;
    }

    await this.publishCreated(schedule, prepared.sender.email);
    return toResponse(schedule);
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
    return toResponse(schedule);
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
            { status: 'cancelled' },
          );
        await manager.getRepository(ScheduledPaymentChange).save({
          scheduledPaymentId: locked.id,
          kind: 'cancelled',
          actor: 'user',
        });
        return locked;
      },
    );
    return toResponse(schedule);
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
      existing.note === (dto.note ?? null) &&
      existing.visibility === dto.visibility;
    if (!same) {
      throw new ScheduleReferenceReusedException();
    }
    return existing;
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
      .countBy({ userId, status: 'active' });
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
}

function toResponse(schedule: ScheduledPayment): ScheduledPaymentResponseDto {
  return {
    id: schedule.id,
    target: { type: 'user', userId: schedule.recipientUserId },
    amount: Money.of(schedule.amount, schedule.currency).toJSON(),
    note: schedule.note,
    visibility: schedule.visibility,
    status: schedule.status,
    nextRunDate: schedule.nextRunAt ? lagosToday(schedule.nextRunAt) : null,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
  };
}
