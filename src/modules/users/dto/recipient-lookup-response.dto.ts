import {
  IdentitySummaryDto,
  toIdentitySummary,
} from '../../../common/dto/identity-summary.dto';
import { User } from '../entities/user.entity';

export class RecipientLookupResponseDto extends IdentitySummaryDto {}

export function toRecipientLookupResponse(
  user: User,
): RecipientLookupResponseDto {
  return toIdentitySummary(user);
}
