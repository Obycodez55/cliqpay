import { ApiProperty } from '@nestjs/swagger';
import { INTERVAL_UNITS, IntervalUnit } from '../internal/run-time';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import {
  SCHEDULE_STATUSES,
  SCHEDULE_TARGET_TYPES,
  ScheduleTargetType,
  SCHEDULE_VISIBILITIES,
  ScheduleStatus,
  ScheduleVisibility,
} from '../entities/scheduled-payment.entity';

export class ScheduledPaymentTargetDto {
  @ApiProperty({ enum: SCHEDULE_TARGET_TYPES })
  type: ScheduleTargetType;

  @ApiProperty({ required: false, description: 'Set for a `user` target' })
  userId?: string;

  @ApiProperty({
    required: false,
    description: 'Set for a `bank_account` target',
  })
  bankAccountId?: string;
}

export class ScheduleFeesDto {
  @ApiProperty({ type: MoneyDto })
  platform: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  provider: MoneyDto;
}

export class ScheduleIntervalResponseDto {
  @ApiProperty({ enum: INTERVAL_UNITS })
  unit: IntervalUnit;

  @ApiProperty()
  count: number;
}

export class ScheduledPaymentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: ScheduledPaymentTargetDto })
  target: ScheduledPaymentTargetDto;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ nullable: true })
  note: string | null;

  @ApiProperty({
    enum: SCHEDULE_VISIBILITIES,
    nullable: true,
    description: 'Null for a bank account target',
  })
  visibility: ScheduleVisibility | null;

  @ApiProperty({
    nullable: true,
    type: ScheduleFeesDto,
    description:
      'Fees debited from the wallet on top of the amount at each run; null for a user target',
  })
  fees: ScheduleFeesDto | null;

  @ApiProperty({
    nullable: true,
    type: ScheduleIntervalResponseDto,
    description: 'Null for a one-time schedule',
  })
  interval: ScheduleIntervalResponseDto | null;

  @ApiProperty({ nullable: true, example: '2027-12-01' })
  endDate: string | null;

  @ApiProperty({ nullable: true })
  maxRuns: number | null;

  @ApiProperty({
    description: 'Runs created so far, whatever their outcome',
  })
  runsUsed: number;

  @ApiProperty({ enum: SCHEDULE_STATUSES })
  status: ScheduleStatus;

  @ApiProperty({
    description:
      'Runs in a row that ended failed; 3 pauses the schedule. A succeeded run resets it.',
  })
  consecutiveFailures: number;

  @ApiProperty({
    nullable: true,
    description:
      'Why the schedule is paused: `user`, a failure code (blocked, recipient_unavailable, sender_frozen, bank_account_removed), or `consecutive_failures`. Null unless paused.',
  })
  pausedReason: string | null;

  @ApiProperty({
    nullable: true,
    example: '2026-12-01',
    description:
      'Lagos date of the next run; null once no run is left to start',
  })
  nextRunDate: string | null;

  @ApiProperty({ nullable: true, description: 'When the next run is due' })
  nextRunAt: string | null;

  @ApiProperty()
  createdAt: string;
}
