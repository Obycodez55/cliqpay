import { ApiProperty } from '@nestjs/swagger';
import { POST_VISIBILITIES, PostVisibility } from '../entities/post.entity';

export class PostStateResponseDto {
  @ApiProperty()
  transactionId: string;

  @ApiProperty({ enum: POST_VISIBILITIES })
  visibility: PostVisibility;

  @ApiProperty({
    description:
      'Whether the post is visible to people who follow a participant',
  })
  isPublic: boolean;

  @ApiProperty({
    description:
      'Whether you have hidden this post from public view. Never says whether anyone else has',
  })
  hidden: boolean;
}
