import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { KycTier } from '../../users/users.service';

type MoneyResponse = { amount: string; currency: string };

export class WalletLimitsResponseDto {
  @ApiProperty({ enum: ['tier0', 'tier1', 'tier2', 'tier3'] })
  tier: KycTier;

  @ApiProperty({
    type: MoneyDto,
    description: "The tier's daily debit limit (transfers and withdrawals).",
  })
  dailyLimit: MoneyResponse;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Transfers and withdrawals (pending or completed, fees excluded) since the start of the Africa/Lagos day.',
  })
  debitedToday: MoneyResponse;

  @ApiProperty({
    type: MoneyDto,
    description:
      'What can still be debited today. A transfer or withdrawal of exactly this amount is allowed; one kobo more is rejected.',
  })
  remainingToday: MoneyResponse;

  @ApiProperty({
    example: '2026-10-23T23:00:00.000Z',
    description:
      'When the daily allowance resets: the next Africa/Lagos midnight.',
  })
  resetsAt: string;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: "The tier's wallet balance cap; null means no cap.",
  })
  balanceCap: MoneyResponse | null;

  @ApiProperty({ type: MoneyDto })
  balance: MoneyResponse;

  @ApiProperty({
    type: MoneyDto,
    description: 'Fundings started but not yet completed.',
  })
  pendingFunding: MoneyResponse;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'What can still be received or funded: the cap minus balance and pending fundings. Null when there is no cap.',
  })
  headroom: MoneyResponse | null;
}
