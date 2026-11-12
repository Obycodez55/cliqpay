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
    type: MoneyDto,
    nullable: true,
    description:
      'The limit the customer set for themselves, if it applies now; never above the tier limit.',
  })
  userLimit: MoneyResponse | null;

  @ApiProperty({
    nullable: true,
    description:
      'A raise of the customer limit that takes effect at `effectiveAt`.',
    example: {
      amount: { amount: '10000000', currency: 'NGN' },
      effectiveAt: '2026-11-11T10:00:00.000Z',
    },
  })
  pendingIncrease: { amount: MoneyResponse; effectiveAt: string } | null;

  @ApiProperty({
    nullable: true,
    description:
      'Present while a recent security change caps outflows: transfers and withdrawals over the rolling last 24 hours may not exceed `limit` until `endsAt`.',
    example: {
      endsAt: '2026-11-11T10:00:00.000Z',
      limit: { amount: '2000000', currency: 'NGN' },
      remaining: { amount: '1500000', currency: 'NGN' },
    },
  })
  cooldown: {
    endsAt: string;
    limit: MoneyResponse;
    remaining: MoneyResponse;
  } | null;

  @ApiProperty({
    type: MoneyDto,
    description:
      'What can be sent or withdrawn right now: the smallest of the tier, the customer limit and the cooldown allowance.',
  })
  effectiveRemaining: MoneyResponse;

  @ApiProperty({
    enum: ['tier', 'user', 'cooldown'],
    description: 'Which limit `effectiveRemaining` comes from.',
  })
  limitedBy: 'tier' | 'user' | 'cooldown';

  @ApiProperty({
    nullable: true,
    description:
      'Present for the first 24 hours after reaching Tier 1: the total the wallet may receive (credited fundings and transfers received) is capped at `limit` until `endsAt`. `remaining` also counts top-ups still in progress.',
    example: {
      endsAt: '2026-11-11T10:00:00.000Z',
      limit: { amount: '2000000', currency: 'NGN' },
      received: { amount: '1500000', currency: 'NGN' },
      remaining: { amount: '500000', currency: 'NGN' },
    },
  })
  newAccountInflow: {
    endsAt: string;
    limit: MoneyResponse;
    received: MoneyResponse;
    remaining: MoneyResponse;
  } | null;

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
