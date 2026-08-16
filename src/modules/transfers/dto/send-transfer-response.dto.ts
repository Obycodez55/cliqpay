import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';

export class SendTransferResponseDto {
  @ApiProperty()
  reference: string;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  // Always present, `0` at the launch default — lets a client render "Free"
  // rather than inferring it from an absent field (docs/architecture.md
  // §4.2).
  @ApiProperty({ type: MoneyDto })
  fee: MoneyDto;

  @ApiProperty()
  recipientUserId: string;

  @ApiProperty()
  createdAt: string;
}
