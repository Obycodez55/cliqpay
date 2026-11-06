import { ApiProperty } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';

export class CommentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: IdentitySummaryDto })
  author: IdentitySummaryDto;

  @ApiProperty()
  body: string;

  @ApiProperty()
  createdAt: Date;
}
