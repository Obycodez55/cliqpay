import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { BankAccount } from './entities/bank-account.entity';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

// Imports payments/auth/ledger/users via their exported services only, and
// never transfers — see docs/adr/0014-withdrawals-module-boundary.md.
// LedgerModule/UsersModule/EventBusModule arrive with issue #28 (initiate
// withdrawal), which is the first thing in this module that actually needs
// them (CLAUDE.md's incremental-build rule) — issue #27 (save/list bank
// accounts) posted nothing to the ledger, never looked up a user, and
// published no events.
@Module({
  imports: [
    TypeOrmModule.forFeature([BankAccount]),
    AuthModule,
    PaymentsModule,
    LedgerModule,
    UsersModule,
    EventBusModule,
  ],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
