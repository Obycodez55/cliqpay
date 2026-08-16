import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { BankAccount } from './entities/bank-account.entity';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

// Imports payments/auth via their exported services only, and never
// transfers — see docs/adr/0014-withdrawals-module-boundary.md. ledger
// isn't wired in yet — issue #27 (save/list bank accounts) posts nothing to
// the ledger; that import arrives with issue #28 (initiate withdrawal),
// which actually needs it (CLAUDE.md's incremental-build rule).
@Module({
  imports: [
    TypeOrmModule.forFeature([BankAccount]),
    AuthModule,
    PaymentsModule,
  ],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
