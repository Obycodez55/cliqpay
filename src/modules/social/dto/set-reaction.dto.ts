import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { REACTIONS, Reaction } from '../entities/post-reaction.entity';

export class SetReactionDto {
  @IsIn(REACTIONS)
  @ApiProperty({ enum: REACTIONS })
  reaction: Reaction;
}
