import { ApiProperty } from '@nestjs/swagger';
import { Dispute } from '../entities/dispute.entity';

class MoneyDto {
  @ApiProperty()
  amount: string;

  @ApiProperty()
  currency: string;
}

export class RecordChargebackResponseDto {
  @ApiProperty()
  disputeId: string;

  @ApiProperty()
  disputeReference: string;

  @ApiProperty({ enum: ['open'] })
  status: 'open';

  @ApiProperty({ type: MoneyDto })
  amount: { amount: string; currency: string };

  @ApiProperty()
  chargebackTransactionId: string;

  @ApiProperty({
    description: 'Whether this chargeback left the account frozen',
  })
  accountFrozen: boolean;

  @ApiProperty()
  createdAt: string;
}

export function toRecordChargebackResponse(
  dispute: Dispute,
  accountFrozen: boolean,
): RecordChargebackResponseDto {
  return {
    disputeId: dispute.id,
    disputeReference: dispute.disputeReference,
    status: 'open',
    amount: { amount: dispute.amount.toString(), currency: dispute.currency },
    chargebackTransactionId: dispute.chargebackTransactionId,
    accountFrozen,
    createdAt: dispute.createdAt.toISOString(),
  };
}
