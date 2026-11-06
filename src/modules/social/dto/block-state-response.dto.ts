import { ApiProperty } from '@nestjs/swagger';

export class BlockStateResponseDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ description: 'Whether you now block this user' })
  blocked: boolean;
}
