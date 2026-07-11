import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config local to @flock/web so that `pnpm -r test:e2e` (which runs
 * `playwright test` with cwd=apps/web) discovers the real e2e specs in
 * apps/web/e2e instead of falling back to the default glob and wrongly
 * collecting the Vitest unit files under src/**\/*.test.tsx.
 *
 * Mirrors the root playwright.config.ts; testDir is resolved relative to this
 * file (apps/web), so it points at apps/web/e2e. testIgnore is set defensively
 * so the unit tests can never be re-collected by the Playwright runner.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/src/**', '**/*.test.tsx', '**/*.test.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: '../../test-results/e2e-junit.xml' }]]
    : 'html',
  outputDir: '../../test-results/playwright',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {},
      },
    },
    {
      name: 'webkit-mobile',
      testMatch: /(?:mobile-routes|terminal)\.spec\.ts/,
      use: { ...devices['iPhone 13'], serviceWorkers: 'block' },
    },
  ],
  webServer:
    process.env.E2E_NO_WEB_SERVER === '1'
      ? undefined
      : {
          command: 'pnpm --filter @flock/web dev --host 0.0.0.0 --port 5173',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
});
