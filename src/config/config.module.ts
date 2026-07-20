import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '.';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
