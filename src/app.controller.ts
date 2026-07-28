import {
  Controller,
  Get,
  Inject,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { AppService } from './app.service';
import { REDIS_CLIENT } from './redis/redis.module';

@ApiTags('app')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Basic liveness greeting' })
  getHello(): string {
    return this.appService.getHello();
  }

  // Unversioned — infra load balancers / orchestrators probe a fixed
  // /health path, not /v1/health.
  @Version(VERSION_NEUTRAL)
  @Get('health')
  @HealthCheck()
  @ApiOperation({ summary: 'Health check for database and Redis connectivity' })
  checkHealth() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      async () => {
        const indicator = this.healthIndicatorService.check('redis');
        try {
          await this.redis.ping();
          return indicator.up();
        } catch (error) {
          return indicator.down({
            message:
              error instanceof Error ? error.message : 'Redis ping failed',
          });
        }
      },
    ]);
  }
}
