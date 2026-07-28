import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../../config';
import { WalletController } from './wallet.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwt.secret }),
    }),
  ],
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
