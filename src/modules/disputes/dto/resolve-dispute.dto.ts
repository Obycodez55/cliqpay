import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsPositive,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export type DisputeResolutionOutcome = 'upheld' | 'resolved';

export class ResolveDisputeDto {
  @MaxLength(100)
  @ApiProperty({
    description:
      "The dispute's own dispute_reference, as recorded by #34's chargeback endpoint",
  })
  disputeReference: string;

  @IsIn(['upheld', 'resolved'])
  @ApiProperty({
    enum: ['upheld', 'resolved'],
    description:
      "'upheld': the bank's ruling stands, no money moves. 'resolved': overturned in Cliqpay's favor, posts a compensating re-credit.",
  })
  outcome: DisputeResolutionOutcome;

  // Required only when outcome is 'resolved' — must equal the dispute's own
  // recorded amount exactly (validated server-side against the `disputes`
  // row, not trusted from this field alone). Resolution always reverses the
  // full chargeback, never a partial amount.
  @ValidateIf((dto: ResolveDisputeDto) => dto.outcome === 'resolved')
  @IsInt()
  @IsPositive()
  @ApiProperty({
    required: false,
    example: 200000,
    description:
      "Required when outcome is 'resolved' — must equal the dispute's own recorded amount, in minor units (kobo)",
  })
  amount?: number;
}
