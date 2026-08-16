import { IsString, IsUUID, Length } from 'class-validator';
import { IsNotWeakTransactionPin } from '../internal/is-not-weak-transaction-pin.validator';

export class ResetTransactionPinDto {
  @IsString()
  @IsNotWeakTransactionPin()
  newPin: string;

  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
