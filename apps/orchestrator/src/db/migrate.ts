/**
 * Flock — idempotent migration runner (spec §6, US-2).
 *
 * Applies committed drizzle migrations from `apps/orchestrator/drizzle/`.
 * Drizzle's migrator records applied migrations in `__drizzle_migrations`, so
 * running this repeatedly is a no-op once up to date — safe to run at boot, in
 * CI, and via `make db-migrate`. Postgres is the system of record only; this
 * never touches the live status path.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb } from './client.js';
import type { DbHandle } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed migrations folder. */
export const MIGRATIONS_FOLDER = path.resolve(here, '../../drizzle');

/**
 * Run all pending migrations against the given (or a freshly created) handle.
 * Idempotent: already-applied migrations are skipped by the drizzle migrator.
 *
 * When this creates its own handle it also closes the pool before returning so
 * the process can exit cleanly. Pass a handle to keep it open (e.g. in tests).
 */
export async function runMigrations(handle?: DbHandle): Promise<void> {
  const owns = handle === undefined;
  const h = handle ?? createDb();
  try {
    await migrate(h.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    if (owns) {
      await h.pool.end();
    }
  }
}

// Allow `tsx src/db/migrate.ts` / `node dist/db/migrate.js` to run directly.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runMigrations()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[migrate] migrations applied');
      process.exit(0);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[migrate] failed', err);
      process.exit(1);
    });
}
