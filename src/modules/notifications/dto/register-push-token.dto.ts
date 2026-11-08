import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import { PUSH_PLATFORMS, PushPlatform } from '../entities/push-token.entity';

export class RegisterPushTokenDto {
  @ApiProperty({ enum: PUSH_PLATFORMS })
  @IsIn(PUSH_PLATFORMS)
  platform: PushPlatform;

  @ApiProperty({ description: 'The FCM registration token for this device' })
  @IsString()
  @Length(1, 4096)
  token: string;
}
