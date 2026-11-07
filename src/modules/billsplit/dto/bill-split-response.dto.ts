import { ApiProperty } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { BILL_SPLIT_MODES, BillSplitMode } from '../entities/bill-split.entity';

export type BillSplitApiStatus = 'open' | 'expired' | 'completed' | 'closed';
export const BILL_SPLIT_API_STATUSES: BillSplitApiStatus[] = [
  'open',
  'expired',
  'completed',
  'closed',
];

export type ShareApiStatus =
  | 'pending'
  | 'paid'
  | 'declined'
  | 'cancelled'
  | 'expired';

export class BillSplitParticipantDto extends IdentitySummaryDto {
  @ApiProperty({ type: MoneyDto, description: "This participant's share" })
  share: MoneyDto;

  @ApiProperty({
    description:
      'The money request carrying this share. Paying or declining goes through /money-requests/{id}; paying it records no post, so its transaction id has none.',
  })
  moneyRequestId: string;

  @ApiProperty({
    enum: ['pending', 'paid', 'declined', 'cancelled', 'expired'],
    description: "The request's live status",
  })
  status: ShareApiStatus;
}

export class BillSplitResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ enum: BILL_SPLIT_MODES })
  mode: BillSplitMode;

  @ApiProperty({ type: MoneyDto })
  total: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description: "The initiator's own share: counted, never requested",
  })
  initiatorShare: MoneyDto;

  @ApiProperty({ type: IdentitySummaryDto })
  initiator: IdentitySummaryDto;

  @ApiProperty({
    enum: BILL_SPLIT_API_STATUSES,
    description:
      'completed when every share is paid; closed when every share is settled and at least one was declined or cancelled; expired once past expiresAt with any share unpaid; otherwise open. Cancelled arrives with a later slice.',
  })
  status: BillSplitApiStatus;

  @ApiProperty({ type: [BillSplitParticipantDto] })
  participants: BillSplitParticipantDto[];

  @ApiProperty()
  expiresAt: string;

  @ApiProperty()
  createdAt: string;
}
