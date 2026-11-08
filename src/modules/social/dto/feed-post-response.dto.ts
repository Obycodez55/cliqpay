import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { REACTIONS, Reaction } from '../entities/post-reaction.entity';
import {
  POST_KINDS,
  POST_ORIGINS,
  POST_VISIBILITIES,
  PostKind,
  PostOrigin,
  PostVisibility,
} from '../entities/post.entity';
import {
  PARTICIPANT_ROLES,
  ParticipantRole,
} from '../entities/post-participant.entity';

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

export class PostParticipantDto extends IdentitySummaryDto {
  @ApiProperty({ enum: PARTICIPANT_ROLES })
  role: ParticipantRole;
}

export class FeedPostResponseDto {
  @ApiProperty({
    description:
      "The post's id, which is its subject's id: the transaction id for a transfer post",
  })
  transactionId: string;

  @ApiProperty({ enum: POST_KINDS })
  kind: PostKind;

  @ApiProperty({ type: IdentitySummaryDto })
  author: IdentitySummaryDto;

  @ApiProperty({
    type: [PostParticipantDto],
    description: 'Everyone on the post, the author included',
  })
  participants: PostParticipantDto[];

  @ApiProperty({ type: String, nullable: true })
  note: string | null;

  @ApiProperty({
    enum: POST_ORIGINS,
    nullable: true,
    description:
      'What led to the post: money_request when it came from paying a direct money request, null for a plain send',
  })
  origin: PostOrigin | null;

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

export class PostResponseDto extends FeedPostResponseDto {
  @ApiPropertyOptional({
    enum: POST_VISIBILITIES,
    description: 'Present only when you are a participant',
  })
  visibility?: PostVisibility;

  @ApiPropertyOptional({
    description:
      'Whether the post is visible to people who follow a participant. Present only when you are a participant',
  })
  isPublic?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether the post has been published. A bill split post is unpublished until the split completes. Present only when you are a participant',
  })
  published?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether you have hidden this post from public view. Present only when you are a participant, and never says whether anyone else has',
  })
  hidden?: boolean;
}
