/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Native dev ports are overridable so we can bind remote-reachable ranges
// (e.g. 11010–11020) without editing this file each time.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = process.env.VITE_API_PROXY ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const flockVersion = readFileSync(new URL('../../agentd/VERSION', import.meta.url), 'utf8').trim();

export default defineConfig({
  plugins: [react()],
  define: {
    __FLOCK_VERSION__: JSON.stringify(flockVersion),
  },
  server: {
    host: '0.0.0.0',
    port: webPort,
    strictPort: true,
    // Native dev: proxy the API + WebSocket channels to the orchestrator so the
    // browser talks to a SINGLE origin (cookies + same-origin fetch just work,
    // exactly like the Caddy prod setup).
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
    // Test-only edits were triggering full client page reloads, which re-ran
    // AuthGate while the API was mid-restart → false "logged out" screens.
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/dist/**',
      ],
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'e2e'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/features/terminal/terminalHarness.tsx',
      ],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: '../../coverage/web',
      thresholds: {
        statements: 58,
        branches: 78,
        functions: 52,
        lines: 58,
        'src/lib/{apiClient,reconnectGate}.ts': {
          statements: 92,
          branches: 86,
          functions: 70,
          lines: 92,
        },
        'src/features/terminal/ptyProtocol.ts': {
          statements: 100,
          branches: 86,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
