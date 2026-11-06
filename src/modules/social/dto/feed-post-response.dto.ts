import { ApiProperty } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { REACTIONS, Reaction } from '../entities/post-reaction.entity';

export class ReactionCountsDto implements Record<Reaction, number> {
  @ApiProperty()
  heart: number;

  @ApiProperty()
  laugh: number;

  @ApiProperty()
  wow: number;

  @ApiProperty()
  fire: number;

  @ApiProperty()
  clap: number;

  @ApiProperty()
  pray: number;
}

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

  @ApiProperty({
    type: ReactionCountsDto,
    description:
      'Count per reaction. Every key is always present, zero when unused.',
  })
  reactionCounts: ReactionCountsDto;

  @ApiProperty({
    enum: REACTIONS,
    nullable: true,
    description: 'Your own reaction, or null if you have none',
  })
  myReaction: Reaction | null;

  @ApiProperty({
    description:
      'Comments you can read: not deleted, and not by anyone you have blocked',
  })
  commentCount: number;
}
