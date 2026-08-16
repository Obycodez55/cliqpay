import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { LoggerModule } from './logger/logger.module';
import { CommonModule } from './common/common.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { EventBusModule } from './shared/events/event-bus.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TransfersModule } from './modules/transfers/transfers.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    CommonModule,
    RateLimitModule,
    RedisModule,
    EventBusModule,
    NotificationsModule,
    LedgerModule,
    UsersModule,
    AuthModule,
    PaymentsModule,
    TransfersModule,
    TerminusModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
