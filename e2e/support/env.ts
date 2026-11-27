import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  // CI provides the variables directly.
}

export const API_PORT = 4100;
export const WEB_PORT = 3200;
export const POS_PORT = 3201;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const POS_URL = `http://localhost:${POS_PORT}`;
export const KDS_PORT = 3202;
export const KDS_URL = `http://localhost:${KDS_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
export const ADMIN_PORT = 3203;
export const ADMIN_URL = `http://localhost:${ADMIN_PORT}`;
/** The POS as a production build: only there is the service worker that lets it open offline. */
export const POS_PROD_PORT = 3204;
export const POS_PROD_URL = `http://localhost:${POS_PROD_PORT}`;
export const MAILPIT_URL = `http://localhost:${process.env.MAILPIT_UI_PORT ?? '8025'}`;

const database = new URL(process.env.DATABASE_URL ?? '');
export const ADMIN_DATABASE_URL = database.toString();
database.pathname = `${database.pathname}_e2e`;
export const DATABASE_URL = database.toString();

const redis = new URL(process.env.REDIS_URL ?? '');
redis.pathname = '/2';
export const REDIS_URL = redis.toString();

/** Accounts created by the seed for these tests only; the database is rebuilt on every run. */
export const OWNER = { email: 'owner@e2e.local', password: 'e2e owner password', pin: '4821' };
export const CASHIER = { email: 'cashier@e2e.local', password: 'e2e cashier password', pin: '7350' };

/** The vendor's own sign-in to the admin app, created by the seed for these tests only. */
export const PLATFORM_ADMIN = { email: 'admin@e2e.local', password: 'platform-e2e-secret-7741', name: 'Asha (support)' };

/** Environment for the API and seed processes the tests start. */
export const serverEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL,
  REDIS_URL,
  API_PORT: String(API_PORT),
  API_PUBLIC_URL: API_URL,
  WEB_URL,
  ADMIN_URL,
  PLATFORM_ADMIN_EMAIL: PLATFORM_ADMIN.email,
  PLATFORM_ADMIN_PASSWORD: PLATFORM_ADMIN.password,
  PLATFORM_ADMIN_NAME: PLATFORM_ADMIN.name,
  SIGNUP_ENABLED: 'true',
  TRIAL_DAYS: '14',
  CORS_ORIGINS: `${WEB_URL},${POS_URL},${KDS_URL},${POS_PROD_URL}`,
  COOKIE_SECURE: 'false',
  STORAGE_LOCAL_DIR: './storage/e2e',
  SEED_OWNER_EMAIL: OWNER.email,
  SEED_OWNER_PASSWORD: OWNER.password,
  SEED_OWNER_PIN: OWNER.pin,
  SEED_CASHIER_EMAIL: CASHIER.email,
  SEED_CASHIER_PASSWORD: CASHIER.password,
  SEED_CASHIER_PIN: CASHIER.pin,
};
