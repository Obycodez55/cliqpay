import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletController } from './wallet.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [UsersModule],
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
