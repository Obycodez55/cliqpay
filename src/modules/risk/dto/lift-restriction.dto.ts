import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import {
  RESTRICTION_REASONS,
  RestrictionReason,
} from '../../users/users.service';

export class LiftRestrictionDto {
  @IsUUID()
  @ApiProperty()
  userId: string;

  @IsIn(RESTRICTION_REASONS)
  @ApiProperty({
    enum: RESTRICTION_REASONS,
    description: "'dispute' and 'sanctions' cannot be lifted here",
  })
  reason: RestrictionReason;

  @IsUUID()
  @ApiProperty()
  sourceId: string;
}
