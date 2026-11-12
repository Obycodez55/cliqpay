import { ApiProperty } from '@nestjs/swagger';

export class SelfLockResponseDto {
  @ApiProperty({ example: true })
  locked: boolean;
}
