import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: '../../coverage/shared',
      thresholds: {
        statements: 92,
        branches: 84,
        functions: 78,
        lines: 92,
        'src/contracts/{auth,operations,projects,source-control,websocket}.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
