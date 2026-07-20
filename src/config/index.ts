import 'dotenv/config';
import { z } from 'zod';

// Only env vars something in the app actually reads. Add a new namespace
// here in the same change that wires it up — not ahead of time. See
// docs/architecture.md for what each phase needs; jwt/encryption/kora/brevo
// belong here once auth, KYC/BVN storage, payments, and email respectively
// are built, not before.
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url(),

  SENTRY_DSN: z.string().url().optional().or(z.literal('')),

  RATE_LIMIT_TTL_MS: z.coerce.number().positive().default(60_000),
  RATE_LIMIT_LIMIT: z.coerce.number().positive().default(100),
});

type Env = z.infer<typeof envSchema>;

function buildConfig(env: Env) {
  return {
    app: {
      env: env.NODE_ENV,
      port: env.PORT,
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    sentry: {
      dsn: env.SENTRY_DSN || undefined,
    },
    rateLimit: {
      ttlMs: env.RATE_LIMIT_TTL_MS,
      limit: env.RATE_LIMIT_LIMIT,
    },
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return buildConfig(result.data);
}

export const APP_CONFIG = Symbol('APP_CONFIG');
