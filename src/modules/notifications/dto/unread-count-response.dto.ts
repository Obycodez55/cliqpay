import { ApiProperty } from '@nestjs/swagger';

export class UnreadCountResponseDto {
  @ApiProperty()
  count: number;
}
