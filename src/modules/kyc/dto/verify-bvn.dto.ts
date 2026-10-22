import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, Matches, ValidateNested } from 'class-validator';
import { LivenessCaptureDto } from './liveness-capture.dto';

export class VerifyBvnDto {
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  @ApiProperty({
    example: '12345678901',
    description: "The user's 11-digit BVN",
  })
  bvn: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LivenessCaptureDto)
  @ApiPropertyOptional({
    type: LivenessCaptureDto,
    description:
      'Liveness capture. Verifies liveness for this account as well; the result may arrive asynchronously (see livenessResult).',
  })
  liveness?: LivenessCaptureDto;
}
