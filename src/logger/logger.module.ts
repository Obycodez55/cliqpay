import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config';

// Fields that must never reach a log line in plain form — bank details, PII,
// tokens, and anything header-carried that could leak a session or secret.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.pin',
  'req.body.transactionPin',
  'req.body.bvn',
  'req.body.nin',
  'req.body.accountNumber',
  'req.body.cardNumber',
  'req.body.cvv',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.token',
  'req.body.code',
  'req.body.challengeId',
  'res.headers["set-cookie"]',
];

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const isProd = config.app.env === 'production';

        return {
          pinoHttp: {
            genReqId: (req: { headers: Record<string, unknown> }) =>
              (req.headers['x-request-id'] as string) ?? randomUUID(),
            redact: {
              paths: REDACT_PATHS,
              censor: '[REDACTED]',
            },
            // Data captured is identical in both environments — redaction
            // and serialization aren't touched here. This only changes what
            // pino-pretty *displays* in dev: full headers, pid, hostname,
            // and per-request query/params/remoteAddress are real data
            // that belongs in production's raw JSON (for an aggregator to
            // search on), but are pure noise on a dev terminal scanning
            // for "which request just failed and why."
            transport: isProd
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    ignore:
                      'pid,hostname,req.headers,req.query,req.params,req.remoteAddress,req.remotePort,res.headers',
                  },
                },
            level: isProd ? 'info' : 'debug',
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
