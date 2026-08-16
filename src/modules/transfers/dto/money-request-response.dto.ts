import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { Money } from '../../../shared/primitives/money';
import {
  MoneyRequest,
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
    expiresAt: moneyRequest.expiresAt.toISOString(),
    createdAt: moneyRequest.createdAt.toISOString(),
  };
}
