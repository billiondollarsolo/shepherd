import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './flock-test';
import { diagnosticsFixture } from './diagnostics-fixture';

const NOW = '2026-07-11T00:00:00.000Z';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

const node = {
  id: NODE_ID,
  name: 'Development node',
  kind: 'local',
  host: null,
  port: null,
  username: null,
  sshAuthMethod: 'key',
  sshHostKey: null,
  pool: null,
  connectionStatus: 'connected',
  lastSeenAt: NOW,
  createdAt: NOW,
};
const project = {
  id: PROJECT_ID,
  nodeId: NODE_ID,
  name: 'Flock',
  workingDir: '/workspace/flock',
  createdAt: NOW,
};
const session = {
  id: SESSION_ID,
  nodeId: NODE_ID,
  projectId: PROJECT_ID,
  agentType: 'codex',
  tmuxSessionName: 'flock-e2e',
  workingDir: project.workingDir,
  status: 'running',
  statusDetail: null,
  note: 'Accessibility agent',
  permissionMode: 'default',
  orchestrationAuthority: 'callback_only',
  createdAt: NOW,
  lastStatusAt: NOW,
  createdBy: '11111111-1111-4111-8111-111111111111',
  closedAt: null,
};

function apiBody(path: string): unknown {
  if (path === '/api/diagnostics') return diagnosticsFixture(NOW);
  if (path === '/api/nodes') return { nodes: [node] };
  if (path === '/api/projects') return { projects: [project] };
  if (path === '/api/sessions') return { sessions: [session] };
  if (path === '/api/agentd/status') return { enabled: false, nodes: [], sessions: {} };
  if (path === '/api/activity/fleet') return { events: [] };
  if (path === '/api/chats/latest') return { chats: {} };
  if (path === '/api/me/preferences') {
    return {
      preferences: {
        version: 1,
        revision: 0,
        updatedAt: NOW,
        nodeOrder: [NODE_ID],
        sessionOrder: {},
        layoutPresets: [],
      },
    };
  }
  if (path === '/api/me/launcher-presets') return { presets: [] };
  if (path === `/api/projects/${PROJECT_ID}/pens`) return { pens: null, revision: 0 };
  if (path === `/api/nodes/${NODE_ID}/info`) {
    return {
      hostname: 'dev-node',
      os: 'Linux',
      kernel: '6.8.0',
      cores: 8,
      uptimeSec: 3600,
      load1: 0.2,
      load5: 0.2,
      load15: 0.2,
      cpuPercent: 12,
      memTotal: 16_000_000_000,
      memUsed: 4_000_000_000,
      diskTotal: 100_000_000_000,
      diskUsed: 30_000_000_000,
      agents: [],
      processes: {},
    };
  }
  if (path === `/api/sessions/${SESSION_ID}/git/status`) {
    return {
      sessionId: SESSION_ID,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      hasHead: true,
      files: [],
      generatedAt: NOW,
    };
  }
  if (path === `/api/nodes/${NODE_ID}/stack`) {
    return { nodeId: NODE_ID, path: project.workingDir, stacks: [], gitRepo: true };
  }
  if (path.endsWith('/events')) return { events: [] };
  return {};
}

async function installFleet(page: Page): Promise<void> {
  await page.unroute('**/api/**');
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === '/api/auth/me'
        ? {
            user: {
              id: '11111111-1111-4111-8111-111111111111',
              username: 'accessibility',
              displayName: 'Accessibility',
              createdAt: NOW,
              lastLoginAt: NOW,
              isActive: true,
            },
          }
        : path === '/api/auth/status'
          ? {
              setupRequired: false,
              setupTokenRequired: false,
              deployment: { mode: 'builtin-tls', transport: 'https', warning: null },
            }
          : apiBody(path);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((value) => localStorage.setItem('flock.theme', value), theme);
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  // Each route is code-split. Waiting for its module/API requests prevents the
  // next navigation from canceling an in-flight import (notably on WebKit).
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // Terminal canvases/rows expose a specialized interactive surface and are
    // covered by terminal keyboard tests rather than generic document rules.
    .exclude('.xterm')
    .exclude('[data-testid="ghostty-mobile-terminal"]')
    .analyze();
  const serious = results.violations
    .filter(({ impact }) => impact === 'serious' || impact === 'critical')
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      targets: nodes.map(({ target }) => target.join(' ')),
      html: nodes.map(({ html }) => html),
    }));
  expect(serious, `${context}: serious/critical axe violations`).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`major desktop routes and dialogs pass axe in ${theme} theme`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(60_000);
    test.skip(browserName === 'webkit', 'desktop coverage runs in Chromium');
    await installFleet(page);
    await page.goto('/');
    await setTheme(page, theme);

    for (const path of [
      '/',
      '/agents',
      `/n/${NODE_ID}`,
      `/p/${PROJECT_ID}`,
      `/p/${PROJECT_ID}/git`,
      ...['appearance', 'notifications', 'nodes', 'account', 'operations', 'about'].map(
        (section) => `/settings/${section}`,
      ),
    ]) {
      await page.goto(path);
      await expectAccessible(page, `${theme} ${path}`);
    }

    await page.goto('/');
    const newButton = page.getByRole('button', { name: 'New', exact: true });
    for (const item of [
      'New node',
      'New project',
      'New session',
      'Race a task…',
      'Config (flock.yml)…',
    ]) {
      await newButton.click();
      await page.getByRole('menuitem', { name: item }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectAccessible(page, `${theme} ${item} dialog`);
      await page.keyboard.press('Escape');
    }

    await page
      .getByRole('button', { name: 'Search agents, projects, nodes, and commands' })
      .click();
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await expectAccessible(page, `${theme} command palette`);
  });

  test(`major mobile routes pass axe in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installFleet(page);
    await page.goto('/');
    await setTheme(page, theme);
    for (const path of [
      '/',
      '/agents',
      `/agents/${SESSION_ID}`,
      `/n/${NODE_ID}`,
      `/p/${PROJECT_ID}/git`,
      '/settings/appearance',
      '/settings/nodes',
      '/settings/operations',
      '/settings/about',
    ]) {
      await page.goto(path);
      await expectAccessible(page, `${theme} mobile ${path}`);
    }
  });
}

test('dialog traps and restores keyboard focus and keyboard focus is visible', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'desktop keyboard coverage runs in Chromium');
  await installFleet(page);
  await page.goto('/');
  const newButton = page.getByRole('button', { name: 'New', exact: true });
  await newButton.focus();
  await newButton.click();
  await page.getByRole('menuitem', { name: 'New node' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(newButton).toBeFocused();

  await page.keyboard.press('Tab');
  const hasVisibleFocus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
  });
  expect(hasVisibleFocus).toBe(true);
});

test('reduced-motion preference disables nonessential animation', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'desktop motion coverage runs in Chromium');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installFleet(page);
  await page.goto('/');
  const motion = await page.locator('[data-testid="fleet-hierarchy"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationDuration, transition: style.transitionDuration };
  });
  expect(Number.parseFloat(motion.animation)).toBeLessThanOrEqual(0.000001);
  expect(Number.parseFloat(motion.transition)).toBeLessThanOrEqual(0.000001);
});
