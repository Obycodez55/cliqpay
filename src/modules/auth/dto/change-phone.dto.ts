import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length } from 'class-validator';
import {
  IsNigerianMobile,
  normalizeNigerianMobile,
} from '../../../common/validation/phone';

export class ChangePhoneDto {
  @Transform(({ value }: { value: unknown }) => normalizeNigerianMobile(value))
  @IsNigerianMobile()
  newPhone: string;

  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
