import { ApiProperty } from '@nestjs/swagger';
import { Dispute } from '../entities/dispute.entity';

class MoneyDto {
  @ApiProperty()
  amount: string;

  @ApiProperty()
  currency: string;
}

export class ResolveDisputeResponseDto {
  @ApiProperty()
  disputeId: string;

  @ApiProperty()
  disputeReference: string;

  @ApiProperty({ enum: ['upheld', 'resolved'] })
  status: 'upheld' | 'resolved';

  @ApiProperty({ type: MoneyDto })
  amount: { amount: string; currency: string };

  @ApiProperty()
  resolvedAt: string;

  @ApiProperty({
    description:
      "Whether this resolution lifted the account's freeze — always false for 'upheld'",
  })
  accountUnfrozen: boolean;
}

export function toResolveDisputeResponse(
  dispute: Dispute,
  accountUnfrozen: boolean,
): ResolveDisputeResponseDto {
  return {
    disputeId: dispute.id,
    disputeReference: dispute.disputeReference,
    status: dispute.status as 'upheld' | 'resolved',
    amount: { amount: dispute.amount.toString(), currency: dispute.currency },
    resolvedAt: dispute.resolvedAt!.toISOString(),
    accountUnfrozen,
  };
}
