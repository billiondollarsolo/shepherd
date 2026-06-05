/**
 * One-off admin/operator password reset (there is no self-serve reset UI yet).
 *
 *   pnpm exec tsx --env-file=.env.dev.local \
 *     apps/orchestrator/src/db/reset-password.ts <username> <newPassword>
 *
 * Hashes the new password with the SAME argon2id used at login and writes it to
 * `users.password_hash`. The new password is whatever you pass — it is never
 * printed or stored anywhere but the hash. Uses DATABASE_URL from the env file.
 */
import { eq } from 'drizzle-orm';

import { hashPassword } from '../auth/hashing.js';
import { createDb } from './client.js';
import { users } from './schema.js';

async function main(): Promise<void> {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error(
      'usage: tsx apps/orchestrator/src/db/reset-password.ts <username> <newPassword>',
    );
    process.exit(2);
  }

  const { db, pool } = createDb();
  try {
    const passwordHash = await hashPassword(password);
    const updated = await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.username, username))
      .returning({ id: users.id });

    if (updated.length === 0) {
      console.error(`No user found with username "${username}".`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ Password reset for "${username}". You can sign in with the new password now.`);
  } finally {
    await pool.end();
  }
}

void main();
