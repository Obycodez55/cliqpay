import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { RecipientController } from './recipient.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [ProfileController, RecipientController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
