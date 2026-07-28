import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class ChangePhoneDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(/^\+?[1-9]\d{6,14}$/, {
    message: 'newPhone must be a valid phone number',
  })
  newPhone: string;

  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
