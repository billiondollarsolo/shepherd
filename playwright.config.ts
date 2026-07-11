import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for UI smoke / e2e tests (`pnpm test:e2e`).
 * Runs against the web dev server. In CI this executes inside the docker
 * `builder` image which ships chromium (CHROME/PUPPETEER paths are set there).
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]]
    : 'html',
  outputDir: 'test-results/playwright',
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
