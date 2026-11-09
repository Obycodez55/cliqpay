import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { RecipientController } from './recipient.controller';
import { UsersService } from './users.service';
import { AuditModule } from '../../shared/audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [ProfileController, RecipientController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
