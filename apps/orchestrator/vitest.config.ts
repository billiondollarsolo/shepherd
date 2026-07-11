import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'orchestrator',
    environment: 'node',
    // Unit tests only. Integration tests use vitest.int.config.ts.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'node_modules', 'dist'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.int.test.ts',
        'src/index.ts',
        'src/db/{migrate,seed,reset-password}.ts',
        'src/status/opencode-plugin/**',
      ],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: '../../coverage/orchestrator',
      thresholds: {
        statements: 60,
        branches: 78,
        functions: 70,
        lines: 60,
        'src/auth/{cookie,hashing,login-throttle,middleware,origin-policy,surface-guard,ws-auth}.ts':
          {
            statements: 88,
            branches: 84,
            functions: 85,
            lines: 88,
          },
        'src/nodes/agentd/{control-auth,protocol}.ts': {
          statements: 74,
          branches: 84,
          functions: 62,
          lines: 74,
        },
        'src/secrets/{keyring,secret-store}.ts': {
          statements: 90,
          branches: 86,
          functions: 84,
          lines: 90,
        },
        'src/sessions/agent-environment-policy.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
