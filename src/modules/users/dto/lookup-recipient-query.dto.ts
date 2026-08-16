import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LookupRecipientQueryDto {
  @Transform(lowercaseTrim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identifier: string;
}
