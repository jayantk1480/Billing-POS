import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { ADMIN_DATABASE_URL, DATABASE_URL, REDIS_URL, REPO_ROOT, serverEnv } from './env.js';
import { deleteTestMail } from './helpers.js';

/** Rebuilds the end-to-end database from migrations and the demo seed, so every run starts the same. */
export default async function globalSetup(): Promise<void> {
  const name = new URL(DATABASE_URL).pathname.slice(1);
  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const databaseDir = path.join(REPO_ROOT, 'packages/database');
  const env = { ...process.env, ...serverEnv };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: databaseDir, env, stdio: 'pipe' });

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
  );
  await db.query(`TRUNCATE TABLE ${tables.rows.map((row) => `"${row.tablename}"`).join(', ')} CASCADE`);
  await db.end();

  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: databaseDir, env, stdio: 'pipe' });

  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  await deleteTestMail();
}
