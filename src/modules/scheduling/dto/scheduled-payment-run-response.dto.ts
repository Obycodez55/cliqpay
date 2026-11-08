import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  AttemptKind,
  AttemptOutcome,
} from '../entities/scheduled-payment-attempt.entity';
import {
  CLIENT_FAILURE_CODES,
  ClientFailureCode,
} from '../internal/failure-reasons';
import { ScheduleFeesDto } from './scheduled-payment-response.dto';
import {
  RUN_STATUSES,
  RunStatus,
} from '../entities/scheduled-payment-run.entity';

export class ScheduledPaymentAttemptResponseDto {
  @ApiProperty({ enum: ATTEMPT_KINDS })
  kind: AttemptKind;

  @ApiProperty({ nullable: true, description: 'Null for a missed run' })
  attemptNumber: number | null;

  @ApiProperty({
    enum: ATTEMPT_OUTCOMES,
    nullable: true,
    description: 'Null for a missed run',
  })
  outcome: AttemptOutcome | null;

  @ApiProperty({
    enum: CLIENT_FAILURE_CODES,
    nullable: true,
    description:
      "Why the attempt failed. A block, the recipient's balance cap and an unavailable recipient all read `recipient_unable_to_receive`.",
  })
  failureCode: ClientFailureCode | null;

  @ApiProperty({ nullable: true })
  transactionId: string | null;

  @ApiProperty({ nullable: true, description: 'Null for a missed run' })
  startedAt: string | null;
}

export class ScheduledPaymentRunResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  runNumber: number;

  @ApiProperty({ example: '2026-12-01', description: 'Lagos date of the run' })
  dueDate: string;

  @ApiProperty({ enum: RUN_STATUSES })
  status: RunStatus;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({
    nullable: true,
    description: 'When the next attempt is due, for a run waiting to retry',
  })
  nextAttemptAt: string | null;

  @ApiProperty({ nullable: true })
  transactionId: string | null;

  @ApiProperty({
    nullable: true,
    type: ScheduleFeesDto,
    description: 'Fees debited on top of the amount; null for a user target',
  })
  fees: ScheduleFeesDto | null;

  @ApiProperty({ type: [ScheduledPaymentAttemptResponseDto] })
  attempts: ScheduledPaymentAttemptResponseDto[];
}
