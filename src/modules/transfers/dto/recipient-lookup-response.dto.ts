import { ApiProperty } from '@nestjs/swagger';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';

export class RecipientLookupResponseDto extends IdentitySummaryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Jane Adaeze Doe',
    description:
      "The recipient's legal name from identity verification, to show the sender before they pay. Null when the recipient has no verified name, and always null when the lookup was by email address, so knowing an email does not reveal the owner's legal name. Returned by this lookup only.",
  })
  verifiedName: string | null;
}
