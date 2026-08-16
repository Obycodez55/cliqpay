import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../../config';
import { ProfileController } from './profile.controller';
import { RecipientController } from './recipient.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
    }),
  ],
  controllers: [ProfileController, RecipientController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
