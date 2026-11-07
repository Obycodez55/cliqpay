import { Module } from '@nestjs/common';
import { TransfersModule } from '../transfers/transfers.module';
import { UsersModule } from '../users/users.module';
import { BillSplitController } from './billsplit.controller';
import { BillSplitService } from './billsplit.service';

@Module({
  imports: [TransfersModule, UsersModule],
  controllers: [BillSplitController],
  providers: [BillSplitService],
  exports: [BillSplitService],
})
export class BillSplitModule {}
