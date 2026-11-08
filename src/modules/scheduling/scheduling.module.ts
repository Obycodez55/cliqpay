import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { KycModule } from '../kyc/kyc.module';
import { SocialModule } from '../social/social.module';
import { TransfersModule } from '../transfers/transfers.module';
import { UsersModule } from '../users/users.module';
import { EventBusModule } from '../../shared/events/event-bus.module';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { RunEngine } from './internal/run-engine.service';
import { RunProcessor } from './internal/run.processor';
import { SweepProcessor } from './internal/sweep.processor';
import {
  SCHEDULED_PAYMENT_RUNS_QUEUE,
  SCHEDULED_PAYMENT_SWEEP_QUEUE,
} from './internal/queues';

@Module({
  imports: [
    TransfersModule,
    UsersModule,
    AuthModule,
    KycModule,
    SocialModule,
    EventBusModule,
    BullModule.registerQueue(
      { name: SCHEDULED_PAYMENT_SWEEP_QUEUE },
      {
        name: SCHEDULED_PAYMENT_RUNS_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ),
  ],
  controllers: [SchedulingController],
  providers: [SchedulingService, RunEngine, SweepProcessor, RunProcessor],
  exports: [SchedulingService],
})
export class SchedulingModule {}
