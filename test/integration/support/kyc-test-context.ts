import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
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
} from './test-app-config';
import { CreateUsersAndAccounts1784628665852 } from '../../../src/database/migrations/1784628665852-CreateUsersAndAccounts';
import { ConvertUsersAndAccountsTimestamps1784707276057 } from '../../../src/database/migrations/1784707276057-ConvertUsersAndAccountsTimestamps';
import { AddUsernameChangedAtToUsers1784707276061 } from '../../../src/database/migrations/1784707276061-AddUsernameChangedAtToUsers';
import { CreateCredentials1784707276062 } from '../../../src/database/migrations/1784707276062-CreateCredentials';
import { AddPendingEmailToUsers1784707276064 } from '../../../src/database/migrations/1784707276064-AddPendingEmailToUsers';
import { AddPendingPhoneToUsers1784707276065 } from '../../../src/database/migrations/1784707276065-AddPendingPhoneToUsers';
import { CreateTransactionsAndLedgerEntries1784707276066 } from '../../../src/database/migrations/1784707276066-CreateTransactionsAndLedgerEntries';
import { AddFundingQueryIndexes1785488695081 } from '../../../src/database/migrations/1785488695081-AddFundingQueryIndexes';
import { EnforceLedgerEntriesAppendOnly1785491930164 } from '../../../src/database/migrations/1785491930164-EnforceLedgerEntriesAppendOnly';
import { CreateNotifications1786812506579 } from '../../../src/database/migrations/1786812506579-CreateNotifications';
import { AddIsFrozenToUsers1787500000001 } from '../../../src/database/migrations/1787500000001-AddIsFrozenToUsers';
import { CreateKycVerifications1787600000000 } from '../../../src/database/migrations/1787600000000-CreateKycVerifications';
import { CreateTierLimits1787600000001 } from '../../../src/database/migrations/1787600000001-CreateTierLimits';
import { AddKycTierToUsers1787600000002 } from '../../../src/database/migrations/1787600000002-AddKycTierToUsers';
import { CreateKycVerificationAttempts1787600000003 } from '../../../src/database/migrations/1787600000003-CreateKycVerificationAttempts';
import { CreateKycLivenessJobs1787600000004 } from '../../../src/database/migrations/1787600000004-CreateKycLivenessJobs';
import { AddKycLimitQueryIndexes1787600000005 } from '../../../src/database/migrations/1787600000005-AddKycLimitQueryIndexes';
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
  postgres: StartedPostgreSqlContainer;
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
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const setupDataSource = new DataSource({
    type: 'postgres',
    url: postgres.getConnectionUri(),
    synchronize: false,
  });
  await setupDataSource.initialize();
  const queryRunner = setupDataSource.createQueryRunner();
  await new CreateUsersAndAccounts1784628665852().up(queryRunner);
  await new ConvertUsersAndAccountsTimestamps1784707276057().up(queryRunner);
  await new AddUsernameChangedAtToUsers1784707276061().up(queryRunner);
  await new CreateCredentials1784707276062().up(queryRunner);
  await new AddPendingEmailToUsers1784707276064().up(queryRunner);
  await new AddPendingPhoneToUsers1784707276065().up(queryRunner);
  await new CreateTransactionsAndLedgerEntries1784707276066().up(queryRunner);
  await new AddFundingQueryIndexes1785488695081().up(queryRunner);
  await new EnforceLedgerEntriesAppendOnly1785491930164().up(queryRunner);
  await new CreateNotifications1786812506579().up(queryRunner);
  await new AddIsFrozenToUsers1787500000001().up(queryRunner);
  await new CreateKycVerifications1787600000000().up(queryRunner);
  await new CreateTierLimits1787600000001().up(queryRunner);
  await new AddKycTierToUsers1787600000002().up(queryRunner);
  await new CreateKycVerificationAttempts1787600000003().up(queryRunner);
  await new CreateKycLivenessJobs1787600000004().up(queryRunner);
  await new AddKycLimitQueryIndexes1787600000005().up(queryRunner);
  await queryRunner.release();
  await setupDataSource.destroy();

  const config: AppConfig = buildTestAppConfig({
    database: { url: postgres.getConnectionUri() },
    redis: {
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      buildTestConfigModule(config),
      buildTestJwtModule(),
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

  const dataSource = moduleRef.get(DataSource);

  return {
    postgres,
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
  await ctx.postgres?.stop();
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
