import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { UsersService } from './users.service';
import { AuditModule } from '../../shared/audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [ProfileController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
