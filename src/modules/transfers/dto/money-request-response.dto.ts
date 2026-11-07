import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { Money } from '../../../shared/primitives/money';
import {
  MONEY_REQUEST_KINDS,
  MoneyRequest,
  MoneyRequestKind,
  MoneyRequestStatus,
} from '../entities/money-request.entity';

export type MoneyRequestApiStatus = MoneyRequestStatus | 'expired';

export class MoneyRequestResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: IdentitySummaryDto })
  counterparty: IdentitySummaryDto;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ nullable: true, example: 'For lunch yesterday' })
  note: string | null;

  // A fifth value that only ever exists here, never in the database — see
  // computeMoneyRequestApiStatus below and ADR-0012.
  @ApiProperty({
    enum: ['pending', 'paid', 'declined', 'cancelled', 'expired'],
  })
  status: MoneyRequestApiStatus;

  @ApiProperty({
    enum: MONEY_REQUEST_KINDS,
    description:
      'Which body paying this request takes: a direct request needs `visibility` in the pay body, a group_share request (one share of a bill split) must omit it and records no post.',
  })
  kind: MoneyRequestKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      "The payment's transaction id once paid, keying its post under /social/posts/{transactionId}; null otherwise. Paying a group-share request (one share of a bill split) records no post, so its transaction id has none.",
  })
  transactionId: string | null;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty()
  createdAt: string;
}

// The stored `status` column has no `expired` value (ADR-0012) — a
// `pending` row whose `expiresAt` has passed presents as expired to
// clients without ever being rewritten in the database.
export function computeMoneyRequestApiStatus(
  status: MoneyRequestStatus,
  expiresAt: Date,
  now: Date,
): MoneyRequestApiStatus {
  return status === 'pending' && expiresAt <= now ? 'expired' : status;
}

export function toMoneyRequestResponse(
  moneyRequest: MoneyRequest,
  counterparty: IdentitySummaryDto,
  now: Date,
): MoneyRequestResponseDto {
  return {
    id: moneyRequest.id,
    counterparty,
    amount: Money.of(moneyRequest.amount, moneyRequest.currency).toJSON(),
    note: moneyRequest.note,
    status: computeMoneyRequestApiStatus(
      moneyRequest.status,
      moneyRequest.expiresAt,
      now,
    ),
    kind: moneyRequest.kind,
    transactionId: moneyRequest.transactionId,
    expiresAt: moneyRequest.expiresAt.toISOString(),
    createdAt: moneyRequest.createdAt.toISOString(),
  };
}
