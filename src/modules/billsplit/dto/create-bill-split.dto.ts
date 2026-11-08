import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { POST_VISIBILITIES, PostVisibility } from '../../social/social.service';
import { BILL_SPLIT_MODES, BillSplitMode } from '../entities/bill-split.entity';

export class BillSplitParticipantInputDto {
  @IsUUID()
  @ApiProperty({ description: "The participant's user id" })
  userId: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @ApiProperty({
    required: false,
    example: 500000,
    description:
      "This participant's share in minor units. Required in custom mode, forbidden in equal mode.",
  })
  amount?: number;
}

export class CreateBillSplitDto {
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-split-8f3e2a1c',
    description:
      'Client-supplied idempotency key, unique per initiator. Replaying it with the same contents returns the original split; with different contents it is a 409.',
  })
  reference: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 140)
  @ApiProperty({
    example: 'Dinner at Nkoyo',
    description: "1–140 characters; becomes each request's note",
  })
  description: string;

  @IsIn(BILL_SPLIT_MODES)
  @ApiProperty({
    enum: BILL_SPLIT_MODES,
    description:
      'equal divides the total among you and the participants, leftover kobo going to your share. custom takes an amount per participant; your share is the remainder.',
  })
  mode: BillSplitMode;

  @IsInt()
  @IsPositive()
  @ApiProperty({
    example: 2000000,
    description: 'The whole bill in minor units (kobo)',
  })
  total: number;

  @IsIn(POST_VISIBILITIES)
  @ApiProperty({
    enum: POST_VISIBILITIES,
    description:
      "Whether the split's feed post may reach your followers once the split completes. Required, no default. Participants see it before they pay and can each hide the post.",
  })
  visibility: PostVisibility;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillSplitParticipantInputDto)
  @ApiProperty({
    type: [BillSplitParticipantInputDto],
    description:
      'Distinct users to request money from, you excluded. At most BILL_SPLIT_MAX_PARTICIPANTS (default 20).',
  })
  participants: BillSplitParticipantInputDto[];
}
