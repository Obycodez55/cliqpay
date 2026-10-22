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

    // ADR-0009: this key can never be rotated without invalidating every
    // PIN in the system.
    TRANSACTION_PIN_PEPPER: z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        'TRANSACTION_PIN_PEPPER must be a 64-character hex string (32 bytes)',
      ),

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

    PAYMENT_PROVIDER: z.enum(['kora', 'fake']).default('fake'),
    KORA_SECRET_KEY: z.string().optional(),

    KORA_WEBHOOK_URL: z.url().optional(),
    PAYMENT_REDIRECT_URL: z.url().optional(),

    RECONCILIATION_ALERT_EMAIL: z.email(),

    // In-app notification rows older than this are deleted regardless of
    // read state — see docs/adr/0013-in-app-notifications.md.
    NOTIFICATION_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(180),

    TRANSFER_PLATFORM_FEE: z.coerce.number().int().nonnegative().default(0),
    TRANSFER_MIN_AMOUNT: z.coerce.number().int().nonnegative().default(10_000),

    // Money requests (ADR-0012) — expiry is derived at read time, never
    // swept, so this only controls what gets stamped on `expires_at` at
    // creation.
    MONEY_REQUEST_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),
    // Cap on outstanding pending requests from one requester to one payer —
    // see ADR-0012's rejection of a daily rate limit instead.
    MONEY_REQUEST_MAX_PENDING_PER_PAIR: z.coerce
      .number()
      .int()
      .positive()
      .default(3),

    WITHDRAWAL_MIN_AMOUNT: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10_000),
    WITHDRAWAL_PLATFORM_FEE: z.coerce.number().int().nonnegative().default(0),
    WITHDRAWAL_PROVIDER_FEE: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(3_000),

    // Shared secret for the `X-Internal-Secret` header on internal/ops
    // endpoints (disputes' chargeback-recording endpoint is the first
    // caller — see docs/adr/0016-disputes-module-boundary.md). Required
    // unconditionally, same as TRANSACTION_PIN_PEPPER — there's no
    // unguarded fallback to degrade to.
    INTERNAL_API_SECRET: z.string().min(32),

    KYC_PROVIDER: z.enum(['smileid', 'fake']).default('fake'),
    SMILE_ID_API_KEY: z.string().optional(),
    SMILE_ID_PARTNER_ID: z.string().optional(),
    SMILE_ID_BASE_URL: z.url().optional(),
    SMILE_ID_PRIVACY_POLICY_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    // A provider's own credentials are only required when it's the one actually selected
    const requireWhen = (
      condition: boolean,
      fields: { path: string; value: string | undefined }[],
    ) => {
      if (!condition) return;
      for (const { path, value } of fields) {
        if (!value) {
          ctx.addIssue({
            code: 'custom',
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
      { path: 'KORA_WEBHOOK_URL', value: env.KORA_WEBHOOK_URL },
      { path: 'PAYMENT_REDIRECT_URL', value: env.PAYMENT_REDIRECT_URL },
    ]);
    requireWhen(env.KYC_PROVIDER === 'smileid', [
      { path: 'SMILE_ID_API_KEY', value: env.SMILE_ID_API_KEY },
      { path: 'SMILE_ID_PARTNER_ID', value: env.SMILE_ID_PARTNER_ID },
      { path: 'SMILE_ID_BASE_URL', value: env.SMILE_ID_BASE_URL },
      {
        path: 'SMILE_ID_PRIVACY_POLICY_URL',
        value: env.SMILE_ID_PRIVACY_POLICY_URL,
      },
    ]);

    // FakeAdapter validates webhook signatures against a hardcoded key
    // committed to the repo (see fake.adapter.ts) — a production deploy
    // that fell through to this default would let anyone forge a funding
    // webhook. Fail at boot, not silently.
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'PAYMENT_PROVIDER must not be "fake" in production',
      });
    }

    if (env.NODE_ENV === 'production' && env.KYC_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['KYC_PROVIDER'],
        message: 'KYC_PROVIDER must not be "fake" in production',
      });
    }
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
    jwt: {
      secret: env.JWT_SECRET,
    },
    encryption: {
      key: env.ENCRYPTION_KEY,
    },
    transactionPin: {
      pepper: env.TRANSACTION_PIN_PEPPER,
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
      retentionDays: env.NOTIFICATION_RETENTION_DAYS,
    },
    payments: {
      provider: env.PAYMENT_PROVIDER,
      kora: {
        secretKey: env.KORA_SECRET_KEY,
        webhookUrl: env.KORA_WEBHOOK_URL,
        redirectUrl: env.PAYMENT_REDIRECT_URL,
      },
      reconciliation: {
        alertEmail: env.RECONCILIATION_ALERT_EMAIL,
      },
    },
    transfers: {
      platformFee: env.TRANSFER_PLATFORM_FEE,
      minAmount: env.TRANSFER_MIN_AMOUNT,
    },
    moneyRequests: {
      expiryDays: env.MONEY_REQUEST_EXPIRY_DAYS,
      maxPendingPerPair: env.MONEY_REQUEST_MAX_PENDING_PER_PAIR,
    },
    withdrawals: {
      minAmount: env.WITHDRAWAL_MIN_AMOUNT,
      platformFee: env.WITHDRAWAL_PLATFORM_FEE,
      providerFee: env.WITHDRAWAL_PROVIDER_FEE,
    },
    internal: {
      apiSecret: env.INTERNAL_API_SECRET,
    },
    kyc: {
      provider: env.KYC_PROVIDER,
      smileId: {
        apiKey: env.SMILE_ID_API_KEY,
        partnerId: env.SMILE_ID_PARTNER_ID,
        baseUrl: env.SMILE_ID_BASE_URL,
        privacyPolicyUrl: env.SMILE_ID_PRIVACY_POLICY_URL,
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
