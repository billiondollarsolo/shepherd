import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'orchestrator',
    environment: 'node',
    // Unit tests only. Integration tests use vitest.int.config.ts.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'node_modules', 'dist'],
    globals: false,
  },
});
