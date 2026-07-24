import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RequestPasswordResetDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  email: string;
}
