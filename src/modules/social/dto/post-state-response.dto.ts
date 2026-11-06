import { ApiProperty } from '@nestjs/swagger';
import {
  POST_VISIBILITIES,
  PostVisibility,
  TransactionPost,
} from '../entities/transaction-post.entity';

export class PostStateResponseDto {
  @ApiProperty()
  transactionId: string;

  @ApiProperty({ enum: POST_VISIBILITIES })
  visibility: PostVisibility;

  @ApiProperty({
    description: 'Whether the recipient has hidden this post from public view',
  })
  hiddenByRecipient: boolean;
}

export function toPostStateResponse(
  post: TransactionPost,
): PostStateResponseDto {
  return {
    transactionId: post.transactionId,
    visibility: post.visibility,
    hiddenByRecipient: post.hiddenByRecipient,
  };
}
