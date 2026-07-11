/**
 * Flock — database client module.
 *
 * Provides a singleton Drizzle client over a `pg` Pool. This is the durable
 * system-of-record connection (spec §6).
 *
 * IMPORTANT: Postgres is NEVER on the live status path (spec §6.6, NFR-PERF1).
 * Callers on the live path must use the orchestrator's in-memory status map and
 * fan out over WebSocket; the event log is written write-behind via this client
 * off the hot path. Treat any synchronous DB call on the status/hook hot path as
 * a bug (spec §15).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';

import { schema } from './schema.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
}

/**
 * Resolve the Postgres connection string. In the dev/compose environment this
 * is provided by the `postgres` service via DATABASE_URL
 * (postgres://flock:flock@postgres:5432/flock).
 */
export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (url?.trim()) return url;
  const passwordFile = env.POSTGRES_PASSWORD_FILE;
  if (passwordFile) {
    const username = env.POSTGRES_USER ?? 'flock';
    const database = env.POSTGRES_DB ?? 'flock';
    const host = env.POSTGRES_HOST ?? 'postgres';
    const port = env.POSTGRES_PORT ?? '5432';
    const password = readFileSync(passwordFile, 'utf8').trim();
    if (!password) throw new Error('POSTGRES_PASSWORD_FILE is empty');
    return `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  }
  throw new Error(
    'DATABASE_URL is not set and POSTGRES_PASSWORD_FILE is unavailable. Expected the compose postgres configuration.',
  );
}

/**
 * Create a fresh database handle (pool + drizzle). Prefer {@link getDb} for the
 * shared singleton; use this directly in tests that need an isolated pool.
 */
export function createDb(connectionString: string = getDatabaseUrl()): DbHandle {
  // T15(b) — explicit pool sizing + timeouts. Without these, `pg` silently caps at
  // 10 connections and lets a stuck query hold a connection forever. `statement_timeout`
  // is applied per connection so a runaway query is killed server-side rather than
  // pinning a pool slot. All tunable via env for different deploy sizes.
  const num = (v: string | undefined, dflt: number): number => {
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const statementTimeoutMs = num(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000);
  const pool = new Pool({
    connectionString,
    max: num(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: num(process.env.DB_POOL_IDLE_MS, 30_000),
    connectionTimeoutMillis: num(process.env.DB_POOL_CONNECT_TIMEOUT_MS, 10_000),
    // Kill any single statement that runs longer than the timeout (0 = disabled).
    statement_timeout: statementTimeoutMs > 0 ? statementTimeoutMs : undefined,
  });
  // A pool 'error' (idle-client crash) is emitted on the Pool, not a request; without
  // a listener Node treats it as an unhandled error and exits the process.
  pool.on('error', (err) => {
    console.error('[db] idle pool client error', err);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

let singleton: DbHandle | undefined;

/** Lazily create and return the process-wide singleton database handle. */
export function getDb(): DbHandle {
  if (!singleton) {
    singleton = createDb();
  }
  return singleton;
}

/** Close the singleton pool (graceful shutdown and integration teardown). */
export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.pool.end();
    singleton = undefined;
  }
}
