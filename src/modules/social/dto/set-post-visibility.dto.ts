import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  POST_VISIBILITIES,
  PostVisibility,
} from '../entities/transaction-post.entity';

export class SetPostVisibilityDto {
  @IsIn(POST_VISIBILITIES)
  @ApiProperty({ enum: POST_VISIBILITIES })
  visibility: PostVisibility;
}
