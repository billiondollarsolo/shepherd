import { expect, test as base } from '@playwright/test';

const expectedConsoleErrors = [
  /401 \(Unauthorized\)/,
  /WebSocket connection.*failed/i,
  /Viewport argument key "interactive-widget" not recognized and ignored/i,
];

const EMPTY_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'e2e-owner',
  displayName: 'E2E Owner',
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

function emptyApiBody(path: string): unknown {
  if (path === '/api/auth/me') return { user: EMPTY_USER };
  if (path === '/api/auth/status') return { setupRequired: false };
  if (path === '/api/nodes') return { nodes: [] };
  if (path === '/api/projects') return { projects: [] };
  if (path === '/api/sessions') return { sessions: [] };
  if (path === '/api/agentd/status') return { enabled: false, nodes: [], sessions: {} };
  if (path === '/api/activity/fleet') return { events: [] };
  if (path === '/api/chats/latest') return { chats: {} };
  if (path === '/api/me/preferences') {
    return {
      preferences: {
        version: 1,
        revision: 0,
        updatedAt: null,
        nodeOrder: [],
        sessionOrder: {},
        layoutPresets: [],
      },
    };
  }
  if (path === '/api/me/launcher-presets') return { presets: [] };
  return {};
}

/**
 * Project-wide browser guard. Browser failures are evidence, not harmless noise:
 * every E2E spec fails on unexpected page errors, console errors, or network
 * failures and Playwright retains the trace/video/screenshot for diagnosis.
 */
const test = base.extend<{ browserHealth: void }>({
  browserHealth: [
    async ({ page }, use) => {
      const failures: string[] = [];
      if (!process.env.FLOCK_E2E_FULLSTACK) {
        await page.route('**/api/**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(emptyApiBody(new URL(route.request().url()).pathname)),
          }),
        );
        await page.routeWebSocket('**/ws/**', (socket) => {
          socket.onMessage(() => undefined);
        });
      }
      page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          !expectedConsoleErrors.some((pattern) => pattern.test(message.text()))
        ) {
          failures.push(`console: ${message.text()}`);
        }
      });
      page.on('requestfailed', (request) => {
        const reason = request.failure()?.errorText ?? 'unknown failure';
        if (reason !== 'net::ERR_ABORTED' && reason !== 'Load request cancelled') {
          failures.push(`request: ${request.url()} (${reason})`);
        }
      });
      await use();
      expect(failures, 'unexpected browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { devices, expect } from '@playwright/test';
export { test };
export type { Locator, Page } from '@playwright/test';
