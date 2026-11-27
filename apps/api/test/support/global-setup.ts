import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { testEnv } from './test-env.js';

/** Creates the test database if needed and brings it up to the latest migration. */
export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  const env = testEnv();
  const testDatabase = new URL(env.DATABASE_URL!).pathname.slice(1);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDatabase]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${testDatabase}"`);
  await admin.end();

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(import.meta.dirname, '../../../../packages/database'),
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: 'pipe',
  });
}
