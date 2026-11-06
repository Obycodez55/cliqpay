import { ApiProperty } from '@nestjs/swagger';
import { REACTIONS, Reaction } from '../entities/post-reaction.entity';

export class ReactionStateResponseDto {
  @ApiProperty()
  transactionId: string;

  @ApiProperty({
    enum: REACTIONS,
    nullable: true,
    description: 'Your reaction on the post now, or null if you have none',
  })
  reaction: Reaction | null;
}
