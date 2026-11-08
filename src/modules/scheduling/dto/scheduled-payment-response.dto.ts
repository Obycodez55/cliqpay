import { ApiProperty } from '@nestjs/swagger';
import { INTERVAL_UNITS, IntervalUnit } from '../internal/run-time';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import {
  SCHEDULE_STATUSES,
  SCHEDULE_VISIBILITIES,
  ScheduleStatus,
  ScheduleVisibility,
} from '../entities/scheduled-payment.entity';

export class ScheduledPaymentTargetDto {
  @ApiProperty({ enum: ['user'] })
  type: 'user';

  @ApiProperty()
  userId: string;
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

  @ApiProperty({ enum: SCHEDULE_VISIBILITIES })
  visibility: ScheduleVisibility;

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
