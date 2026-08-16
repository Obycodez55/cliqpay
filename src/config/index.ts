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

    // HMAC-SHA256 pepper applied before bcrypt on transaction PINs — 32
    // bytes as hex, required unconditionally (unlike the provider secrets
    // below) since there's no unpeppered fallback to degrade to. See
    // ADR-0009: this key can never be rotated without invalidating every
    // PIN in the system.
    TRANSACTION_PIN_PEPPER: z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        'TRANSACTION_PIN_PEPPER must be a 64-character hex string (32 bytes)',
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

    // Sent as `notification_url` on every charge — this backend's own
    // webhook receiver, not a frontend page. Optional/undocumented until
    // now (Phase 2 audit, M2): without it, the webhook path depended
    // entirely on whatever's configured in Kora's dashboard, which nothing
    // in this repo could confirm or review.
    KORA_WEBHOOK_URL: z.url().optional(),
    // Sent as `redirect_url` — where Kora's hosted checkout sends the
    // customer back to after paying. No frontend exists yet
    // (docs/architecture.md §9), so this is a placeholder until one does.
    // The webhook, not this redirect, is what actually completes the
    // funding transaction (§4.2) — this only affects where the customer's
    // browser ends up.
    PAYMENT_REDIRECT_URL: z.url().optional(),

    RECONCILIATION_ALERT_EMAIL: z.email(),

    // In-app notification rows older than this are deleted regardless of
    // read state — see docs/adr/0013-in-app-notifications.md.
    NOTIFICATION_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(180),

    // Flat, config-driven platform fee on P2P transfers, minor units.
    // Launches at 0 — see docs/architecture.md §4.2 for why the fee_income
    // leg is only posted when this is non-zero.
    TRANSFER_PLATFORM_FEE: z.coerce.number().int().nonnegative().default(0),
    // Bounds per transfer, minor units. The maximum is an interim ceiling
    // until Phase 6 KYC tier limits replace it.
    TRANSFER_MIN_AMOUNT: z.coerce.number().int().nonnegative().default(10_000),
    TRANSFER_MAX_AMOUNT: z.coerce
      .number()
      .int()
      .positive()
      .default(100_000_000),

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
      { path: 'KORA_WEBHOOK_URL', value: env.KORA_WEBHOOK_URL },
      { path: 'PAYMENT_REDIRECT_URL', value: env.PAYMENT_REDIRECT_URL },
    ]);

    // FakeAdapter validates webhook signatures against a hardcoded key
    // committed to the repo (see fake.adapter.ts) — a production deploy
    // that fell through to this default would let anyone forge a funding
    // webhook. Fail at boot, not silently.
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'PAYMENT_PROVIDER must not be "fake" in production',
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
      maxAmount: env.TRANSFER_MAX_AMOUNT,
    },
    moneyRequests: {
      expiryDays: env.MONEY_REQUEST_EXPIRY_DAYS,
      maxPendingPerPair: env.MONEY_REQUEST_MAX_PENDING_PER_PAIR,
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
