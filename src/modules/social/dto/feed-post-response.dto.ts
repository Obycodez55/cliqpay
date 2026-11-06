import { ApiProperty } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';

export class FeedPostResponseDto {
  @ApiProperty()
  transactionId: string;

  @ApiProperty({ type: IdentitySummaryDto })
  sender: IdentitySummaryDto;

  @ApiProperty({ type: IdentitySummaryDto })
  recipient: IdentitySummaryDto;

  @ApiProperty({ type: String, nullable: true })
  note: string | null;

  @ApiProperty()
  createdAt: Date;
}
