import { ApiProperty } from '@nestjs/swagger';

export class FollowStateResponseDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ description: 'Whether you now follow this user' })
  follows: boolean;
}
