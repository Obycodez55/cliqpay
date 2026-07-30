import 'dotenv/config';
import { z } from 'zod';

// Only env vars something in the app actually reads. Add a new namespace
// here in the same change that wires it up — not ahead of time. See
// docs/architecture.md for what each phase needs; encryption/kora belong
// here once KYC/BVN storage and payments respectively are built, not before.
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ALLOWED_ORIGINS: z.string().default(''),

    // Base URL the email-verification link points at — the client app reads
    // the `token` query param and calls POST /auth/verify-email with it.
    // No frontend exists yet (docs/architecture.md §9), so this defaults to
    // a placeholder for local dev; production must set a real one.
    EMAIL_VERIFICATION_URL: z
      .url()
      .default('http://localhost:3000/verify-email'),

    // Same reasoning as EMAIL_VERIFICATION_URL above, for the
    // password-reset link — no frontend exists yet, placeholder default for
    // local dev.
    PASSWORD_RESET_URL: z.url().default('http://localhost:3000/reset-password'),

    DATABASE_URL: z.string().url(),

    REDIS_URL: z.string().url(),

    SENTRY_DSN: z.string().url().optional().or(z.literal('')),

    RATE_LIMIT_TTL_MS: z.coerce.number().positive().default(60_000),
    RATE_LIMIT_LIMIT: z.coerce.number().positive().default(100),

    JWT_SECRET: z.string().min(32),

    // AES-256-GCM key for encrypting TOTP secrets at rest — 32 bytes as hex.
    // Generate with `openssl rand -hex 32`.
    ENCRYPTION_KEY: z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)',
      ),

    // Named per concrete provider, not a real/fake toggle — `fake` is just
    // another option in the same set, so adding a second real provider for a
    // channel (e.g. SES alongside Brevo) is adding an enum value, not
    // reshaping this into something else.
    EMAIL_PROVIDER: z.enum(['brevo', 'fake']).default('fake'),
    SMS_PROVIDER: z.enum(['termii', 'fake']).default('fake'),
    PUSH_PROVIDER: z.enum(['fcm', 'fake']).default('fake'),

    BREVO_API_KEY: z.string().optional(),
    BREVO_SENDER_EMAIL: z.string().optional(),
    BREVO_SENDER_NAME: z.string().optional(),

    TERMII_API_KEY: z.string().optional(),
    TERMII_SENDER_ID: z.string().optional(),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    // Same real/fake-as-just-another-provider pattern as the notification
    // channels above — 'fake' (the default) runs FakeAdapter, no network,
    // no Kora credentials required.
    PAYMENT_PROVIDER: z.enum(['kora', 'fake']).default('fake'),
    KORA_SECRET_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // A provider's own credentials are only required when it's the one
    // actually selected — this is what lets EMAIL_PROVIDER=fake (etc., the
    // default) run with zero real credentials configured.
    const requireWhen = (
      condition: boolean,
      fields: { path: string; value: string | undefined }[],
    ) => {
      if (!condition) return;
      for (const { path, value } of fields) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `${path} is required when its provider is selected`,
          });
        }
      }
    };

    requireWhen(env.EMAIL_PROVIDER === 'brevo', [
      { path: 'BREVO_API_KEY', value: env.BREVO_API_KEY },
      { path: 'BREVO_SENDER_EMAIL', value: env.BREVO_SENDER_EMAIL },
    ]);
    requireWhen(env.SMS_PROVIDER === 'termii', [
      { path: 'TERMII_API_KEY', value: env.TERMII_API_KEY },
      { path: 'TERMII_SENDER_ID', value: env.TERMII_SENDER_ID },
    ]);
    requireWhen(env.PUSH_PROVIDER === 'fcm', [
      { path: 'FIREBASE_PROJECT_ID', value: env.FIREBASE_PROJECT_ID },
      { path: 'FIREBASE_CLIENT_EMAIL', value: env.FIREBASE_CLIENT_EMAIL },
      { path: 'FIREBASE_PRIVATE_KEY', value: env.FIREBASE_PRIVATE_KEY },
    ]);
    requireWhen(env.PAYMENT_PROVIDER === 'kora', [
      { path: 'KORA_SECRET_KEY', value: env.KORA_SECRET_KEY },
    ]);
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
      emailVerificationUrl: env.EMAIL_VERIFICATION_URL,
      passwordResetUrl: env.PASSWORD_RESET_URL,
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
    jwt: {
      secret: env.JWT_SECRET,
    },
    encryption: {
      key: env.ENCRYPTION_KEY,
    },
    notifications: {
      emailProvider: env.EMAIL_PROVIDER,
      smsProvider: env.SMS_PROVIDER,
      pushProvider: env.PUSH_PROVIDER,
      brevo: {
        apiKey: env.BREVO_API_KEY,
        senderEmail: env.BREVO_SENDER_EMAIL,
        senderName: env.BREVO_SENDER_NAME,
      },
      termii: {
        apiKey: env.TERMII_API_KEY,
        senderId: env.TERMII_SENDER_ID,
      },
      firebase: {
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      },
    },
    payments: {
      provider: env.PAYMENT_PROVIDER,
      kora: {
        secretKey: env.KORA_SECRET_KEY,
      },
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
