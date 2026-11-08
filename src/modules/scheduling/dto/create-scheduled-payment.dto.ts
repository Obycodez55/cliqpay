import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';
import { IsNotReservedReference } from '../../../common/validation/reference';
import {
  SCHEDULE_VISIBILITIES,
  ScheduleVisibility,
} from '../entities/scheduled-payment.entity';

export class ScheduleTargetDto {
  @Equals('user')
  @ApiProperty({ enum: ['user'] })
  type: 'user';

  @IsUUID()
  @ApiProperty({ description: "The recipient's user id" })
  userId: string;
}

export class CreateScheduledPaymentDto {
  @IsNotReservedReference()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-sched-8f3e2a1c',
    description:
      'Client-supplied idempotency key, unique per user. Replaying it with the same contents returns the original schedule; with different contents it is a 409.',
  })
  reference: string;

  @ValidateNested()
  @Type(() => ScheduleTargetDto)
  @ApiProperty({ type: ScheduleTargetDto })
  target: ScheduleTargetDto;

  @IsInt()
  @IsPositive()
  @ApiProperty({ example: 500000, description: 'Amount in minor units (kobo)' })
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be a YYYY-MM-DD date',
  })
  @ApiProperty({
    example: '2026-12-01',
    description:
      'Lagos calendar date of the payment: tomorrow at the earliest, one year ahead at the latest. The payment runs on the morning of that date.',
  })
  startDate: string;

  @Transform(({ value }: { value: unknown }) => {
    const note = normalizeText(value);
    return note === '' ? undefined : note;
  })
  @IsOptional()
  @IsString()
  @HasCodePointLength(1, 500)
  @ApiProperty({ required: false, example: 'Rent' })
  note?: string;

  @IsIn(SCHEDULE_VISIBILITIES)
  @ApiProperty({
    enum: SCHEDULE_VISIBILITIES,
    description:
      'Whether the transfer made on the run date may appear in the activity feed. Required; there is no default.',
  })
  visibility: ScheduleVisibility;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({
    description:
      '4-digit transaction PIN, which authorises every run of this schedule',
  })
  pin: string;
}
