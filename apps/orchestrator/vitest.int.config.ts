import { defineConfig } from 'vitest/config';

/**
 * Integration tests: require real services (postgres / tmux / ssh / chromium)
 * and run inside the docker dev containers via `pnpm test:int` (Makefile
 * `test-int`). Named `*.int.test.ts`.
 */
export default defineConfig({
  test: {
    name: 'orchestrator-int',
    environment: 'node',
    include: ['src/**/*.int.test.ts', 'test/int/**/*.test.ts'],
    // Force a dedicated `*_test` database so the (destructive) int tests can
    // NEVER touch the dev/prod DB, regardless of DATABASE_URL. See int-setup.ts.
    globalSetup: ['./test/int-setup.ts'],
    globals: false,
    // Integration tests share a single DB; run serially to avoid cross-talk.
    fileParallelism: false,
    // Real services can be slow to come up.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
