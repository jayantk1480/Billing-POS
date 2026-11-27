import path from 'node:path';
import { z } from 'zod';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

// One .env at the repository root serves every app; in production the variables are injected.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  // No .env file: rely on the process environment.
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('Rasoi POS'),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.string().default('no-reply@localhost'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // "s3" is added with the production deployment work; until then only local disk is accepted.
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  /** Number of proxy hops to trust for the client IP (1 behind a load balancer, 0 when exposed directly). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  WEB_URL: z.url().default('http://localhost:3100'),
  /** The platform admin app. Only requests from this address may use the platform routes. */
  ADMIN_URL: z.url().default('http://localhost:3103'),
  /** Whether restaurants can register themselves. Off means only the platform admin creates them. */
  SIGNUP_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

/** Validated configuration. The process refuses to start if anything required is missing. */
export const env: Env = loadEnv();
