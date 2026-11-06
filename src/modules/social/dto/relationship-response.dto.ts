import { ApiProperty } from '@nestjs/swagger';

export class RelationshipResponseDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ description: 'Whether you follow this user' })
  follows: boolean;

  @ApiProperty({ description: 'Whether this user follows you' })
  followedBy: boolean;

  @ApiProperty({ description: 'Whether you have blocked this user' })
  blocked: boolean;

  @ApiProperty()
  followerCount: number;

  @ApiProperty()
  followingCount: number;
}
