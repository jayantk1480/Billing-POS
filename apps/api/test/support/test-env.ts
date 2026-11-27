import path from 'node:path';

/**
 * Integration tests use their own database ("<name>_test") and Redis database 1,
 * so they never touch development data.
 */
export function testEnv(): Record<string, string> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '../../../../.env'));
  } catch {
    // CI provides the variables directly.
  }
  const database = new URL(process.env.DATABASE_URL ?? '');
  database.pathname = `${database.pathname}_test`;
  const redis = new URL(process.env.REDIS_URL ?? '');
  redis.pathname = '/1';
  return {
    NODE_ENV: 'test',
    DATABASE_URL: database.toString(),
    REDIS_URL: redis.toString(),
    COOKIE_SECURE: 'false',
    CORS_ORIGINS: 'http://localhost:3100,http://localhost:3101',
    // Not a real address: reset links in test emails must never open the development app.
    WEB_URL: 'http://back-office.test',
    ADMIN_URL: 'http://admin.test',
    SIGNUP_ENABLED: 'true',
    TRIAL_DAYS: '14',
    API_PUBLIC_URL: 'http://localhost:4000',
    STORAGE_LOCAL_DIR: './storage/test',
    SMTP_HOST: process.env.SMTP_HOST ?? 'localhost',
    SMTP_PORT: process.env.SMTP_PORT ?? '1025',
    MAILPIT_URL: `http://localhost:${process.env.MAILPIT_UI_PORT ?? '8025'}`,
  };
}
