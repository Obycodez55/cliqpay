import { IsString, Length } from 'class-validator';

export class ConfirmTotpDto {
  @IsString()
  @Length(6, 6)
  code: string;
}
