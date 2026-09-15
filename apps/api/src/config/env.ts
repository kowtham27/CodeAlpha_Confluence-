import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// One .env at the monorepo root, shared by the API, the web app and compose.
// In containers the values arrive via env_file and this call finds nothing,
// which is the intended no-op.
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });

/** An optional setting where an empty value (`SMTP_USER=`) means unset. */
const optionalText = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

/**
 * Spec section 5: all secrets come from the environment and are validated at
 * process start. A malformed or missing variable stops the process here, with
 * a readable message, rather than surfacing as a null-pointer three layers in.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    WEB_ORIGIN: z.url(),

    DATABASE_URL: z.string().startsWith('postgresql://'),
    REDIS_URL: z.string().startsWith('redis://'),

    // Consumed in Phase 1.
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),

    // Consumed in Phase 3. Must match the value coturn was started with.
    TURN_REALM: z.string().min(1),
    TURN_STATIC_AUTH_SECRET: z.string().min(16),
    TURN_PORT: z.coerce.number().int().min(1).max(65535).default(3478),
    // Host the BROWSER uses to reach coturn. Not the compose service name:
    // the browser runs outside Docker.
    TURN_HOST: z.string().min(1).default('localhost'),

    // Phase 1: email verification. 'memory' keeps mail in-process for tests.
    MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
    // SMTP_HOST is the switch: unset, every email goes to the local Mailpit
    // (at MAILPIT_HOST, which compose sets to its service name); set, email is
    // sent for real through that server with the settings below.
    SMTP_HOST: optionalText,
    MAILPIT_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    // z.coerce.boolean() would read the string "false" as true.
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: optionalText,
    SMTP_PASS: optionalText,
    MAIL_FROM: z.string().min(3).default('Confluence <no-reply@confluence.local>'),

    // Phase 5: S3-compatible storage for encrypted files. The API calls
    // S3_ENDPOINT; presigned URLs use S3_PUBLIC_ENDPOINT, the one browsers reach.
    S3_ENDPOINT: z.url(),
    S3_PUBLIC_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3).max(63),
    S3_ACCESS_KEY: z.string().min(3),
    S3_SECRET_KEY: z.string().min(8),
  })
  // Real email: catch the usual mistakes at start, not at the first sign-up.
  .superRefine((env, ctx) => {
    if (!env.SMTP_HOST) return;
    if (env.SMTP_USER && !env.SMTP_PASS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_PASS'],
        message: 'required with SMTP_USER (for Gmail, a 16-character App Password)',
      });
    }
    if (env.MAIL_FROM.includes('.local>')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message:
          'must be an address your SMTP server may send from, e.g. "Confluence <you@gmail.com>"',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Intentionally console + exit rather than the logger: the logger itself
    // is configured from env, so it may not exist yet.
    console.error(`Invalid environment configuration:\n${issues}\n`);
    console.error('Copy .env.example to .env and fill in the missing values.');
    process.exit(1);
  }

  const env = parsed.data;

  // Placeholder secrets are fine in dev and a breach in production.
  if (env.NODE_ENV === 'production') {
    const placeholders = (
      [
        ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
        ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
        ['TURN_STATIC_AUTH_SECRET', env.TURN_STATIC_AUTH_SECRET],
        ['S3_SECRET_KEY', env.S3_SECRET_KEY],
      ] as const
    ).filter(([, value]) => value.startsWith('change_me'));

    if (placeholders.length > 0) {
      console.error(
        `Refusing to start in production with placeholder secrets: ${placeholders
          .map(([name]) => name)
          .join(', ')}`,
      );
      process.exit(1);
    }
  }

  return env;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
