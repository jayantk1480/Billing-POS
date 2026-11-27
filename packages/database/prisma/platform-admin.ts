/**
 * Creates the vendor's own sign-in to the platform admin app, or sets a new password on it.
 * This is the production counterpart of the seed: it adds no demo restaurant.
 *
 *   PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD (at least 12 characters), PLATFORM_ADMIN_NAME (optional)
 *
 * Run it again with a new PLATFORM_ADMIN_PASSWORD to change the password; that also signs the admin out everywhere.
 */
import path from 'node:path';
import argon2 from 'argon2';
import { createPrismaClient, syncPermissions } from '../src/index.js';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // Variables are already in the environment.
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value === 'change-me') throw new Error(`Set ${name} before running this`);
  return value;
}

const prisma = createPrismaClient(requireEnv('DATABASE_URL'));

async function main() {
  const email = requireEnv('PLATFORM_ADMIN_EMAIL').toLowerCase();
  const password = requireEnv('PLATFORM_ADMIN_PASSWORD');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('PLATFORM_ADMIN_EMAIL is not an email address');
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  const name = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform admin';

  // Every restaurant's roles point at this list, so it has to exist before the first restaurant registers.
  await prisma.$transaction((tx) => syncPermissions(tx));

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const existing = await prisma.platformAdmin.findUnique({ where: { email } });
  if (existing) {
    await prisma.$transaction([
      prisma.platformAdmin.update({ where: { id: existing.id }, data: { passwordHash, name, isActive: true, failedLoginCount: 0, lockedUntil: null } }),
      // Whoever was signed in with the old password is signed out.
      prisma.platformSession.deleteMany({ where: { adminId: existing.id } }),
    ]);
    console.log('Password changed for platform admin ' + email);
  } else {
    await prisma.platformAdmin.create({ data: { email, name, passwordHash } });
    console.log('Created platform admin ' + email);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
