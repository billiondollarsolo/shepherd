import { defineWorkspace } from 'vitest/config';

/**
 * Root Vitest workspace. Each package/app contributes its own vitest config so
 * the correct environment (node vs jsdom) is used. Run with `pnpm test:unit`.
 *
 * Integration tests (requiring real postgres/tmux/ssh/chrome) are NOT part of
 * this workspace; they run via each package's `test:int` script inside the
 * docker `builder`/service containers (see Makefile `test-int`).
 */
export default defineWorkspace([
  './packages/shared/vitest.config.ts',
  './apps/orchestrator/vitest.config.ts',
  // web's vitest config is colocated in its vite.config.ts (jsdom env).
  './apps/web/vite.config.ts',
]);
