import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../src/config';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  buildTestAppConfig,
  buildTestConfigModule,
  buildTestJwtModule,
  buildTestPipelineModules,
} from './test-app-config';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './test-database';
import { KycRetentionProcessor } from '../../../src/modules/kyc/internal/kyc-retention.processor';
import { LivenessPollProcessor } from '../../../src/modules/kyc/internal/liveness-poll.processor';
import { setupBodyParsers } from '../../../src/common/body-parsers';
import { User } from '../../../src/modules/users/entities/user.entity';
import { UsersModule } from '../../../src/modules/users/users.module';
import { UsersService } from '../../../src/modules/users/users.service';
import { KycModule } from '../../../src/modules/kyc/kyc.module';
import { KycService } from '../../../src/modules/kyc/kyc.service';
import { KycVerification } from '../../../src/modules/kyc/entities/kyc-verification.entity';
import { KycVerificationAttempt } from '../../../src/modules/kyc/entities/kyc-verification-attempt.entity';
import { KycLivenessJob } from '../../../src/modules/kyc/entities/kyc-liveness-job.entity';
import { TierLimit } from '../../../src/modules/kyc/entities/tier-limit.entity';
import { closeBullmqWorkers } from './bullmq-teardown';

export interface KycTestContext {
  database: TestDatabase;
  redis: StartedTestContainer;
  app: INestApplication<App>;
  usersService: UsersService;
  kycService: KycService;
  dataSource: DataSource;
  userRepo: Repository<User>;
  kycVerificationRepo: Repository<KycVerification>;
  tierLimitRepo: Repository<TierLimit>;
  kycVerificationAttemptRepo: Repository<KycVerificationAttempt>;
  kycLivenessJobRepo: Repository<KycLivenessJob>;
  config: AppConfig;
}

export async function createKycTestContext(): Promise<KycTestContext> {
  const database = await createTestDatabase();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const config: AppConfig = buildTestAppConfig({
    database: { url: database.url },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      buildTestConfigModule(config),
      buildTestJwtModule(),
      ...buildTestPipelineModules(),
      TypeOrmModule.forRootAsync({
        inject: [APP_CONFIG],
        useFactory: (cfg: AppConfig) => buildDataSourceOptions(cfg),
      }),
      UsersModule,
      KycModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  setupBodyParsers(app);
  await app.init();

  // Tests settle liveness jobs themselves via pollPendingLivenessJobs(), so a
  // background poll must not race them.
  const pollHost = app.get(LivenessPollProcessor, { strict: false });
  await pollHost.worker.waitUntilReady();
  await pollHost.worker.pause();
  const retentionHost = app.get(KycRetentionProcessor, { strict: false });
  await retentionHost.worker.waitUntilReady();
  await retentionHost.worker.pause();

  const dataSource = moduleRef.get(DataSource);

  return {
    database,
    redis,
    app,
    usersService: moduleRef.get(UsersService),
    kycService: moduleRef.get(KycService),
    dataSource,
    userRepo: dataSource.getRepository(User),
    kycVerificationRepo: dataSource.getRepository(KycVerification),
    tierLimitRepo: dataSource.getRepository(TierLimit),
    kycVerificationAttemptRepo: dataSource.getRepository(
      KycVerificationAttempt,
    ),
    kycLivenessJobRepo: dataSource.getRepository(KycLivenessJob),
    config,
  };
}

export async function destroyKycTestContext(
  ctx: Partial<KycTestContext>,
): Promise<void> {
  if (ctx.app) {
    await closeBullmqWorkers(ctx.app);
  }
  await ctx.app?.close();
  await dropTestDatabase(ctx.database);
  await ctx.redis?.stop();
}

export async function seedKycUser(
  ctx: KycTestContext,
  overrides: { email: string; phone: string; username: string },
): Promise<{ userId: string }> {
  return ctx.dataSource.transaction(async (manager) => {
    const user = await ctx.usersService.createUser(manager, {
      email: overrides.email,
      phone: overrides.phone,
      username: overrides.username,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await manager
      .getRepository(User)
      .update({ id: user.id }, { emailVerifiedAt: new Date() });
    return { userId: user.id };
  });
}
