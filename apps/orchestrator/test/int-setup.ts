/**
 * Integration-test DB guard.
 *
 * Integration tests are DESTRUCTIVE — several `beforeAll` hooks truncate/clear
 * tables (e.g. `users`) to get a deterministic state. They must therefore NEVER
 * run against the dev/prod database. This setup file (run by vitest before every
 * int test file, see vitest.int.config.ts) forces DATABASE_URL onto a dedicated
 * `*_test` database, creating it on first use. Result: `pnpm test:int` is safe
 * no matter what DATABASE_URL points at.
 */
import { Client } from 'pg';

/** Swap the database name in a postgres URL to a `_test` sibling. */
function toTestUrl(url: string): { testUrl: string; adminUrl: string; testDb: string } {
  const u = new URL(url);
  const baseDb = (u.pathname.replace(/^\//, '') || 'flock').replace(/_test$/, '');
  const testDb = `${baseDb}_test`;
  const testUrl = new URL(url);
  testUrl.pathname = `/${testDb}`;
  // Connect to the stock `postgres` maintenance DB to issue CREATE DATABASE.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  return { testUrl: testUrl.toString(), adminUrl: adminUrl.toString(), testDb };
}

export async function setup(): Promise<void> {
  const current = process.env.DATABASE_URL ?? 'postgres://flock:flock@localhost:5432/flock';
  const { testUrl, adminUrl, testDb } = toTestUrl(current);

  // Create the test database if it does not exist (idempotent).
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      testDb,
    ]);
    if (!rowCount) {
      // identifier is derived from our own base name; safe to interpolate.
      await admin.query(`CREATE DATABASE ${testDb}`);
    }
  } finally {
    await admin.end();
  }

  // Point every int test at the test DB. createDb() reads this at call time.
  process.env.DATABASE_URL = testUrl;
}
