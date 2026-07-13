/**
 * Shepherd — drizzle-kit configuration (spec §6, US-2).
 *
 * `db:generate` reads this to emit migration SQL into `./drizzle`, which is
 * committed to the repo. `db:migrate` (src/db/migrate.ts) applies them
 * idempotently at boot and in CI.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://flock:flock@postgres:5432/flock',
  },
  strict: true,
  verbose: true,
});
