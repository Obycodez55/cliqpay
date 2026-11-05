import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { WalletController } from './wallet.controller';

@Module({
  imports: [LedgerModule, UsersModule],
  controllers: [WalletController],
})
export class WalletModule {}
