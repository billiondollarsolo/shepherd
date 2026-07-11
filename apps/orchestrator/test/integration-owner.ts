import type { Database } from '../src/db/client.js';
import { users } from '../src/db/schema.js';

/** Reuse the single installation owner in the serial integration-test database. */
export async function ensureIntegrationOwner(
  db: Database,
  username: string,
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) return { id: existing.id, created: false };
  const [created] = await db
    .insert(users)
    .values({ username, passwordHash: 'argon2id$integration-fixture' })
    .returning({ id: users.id });
  return { id: created!.id, created: true };
}
