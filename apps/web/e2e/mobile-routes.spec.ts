import { expect, test, type Page } from './flock-test';
import { diagnosticsFixture } from './diagnostics-fixture';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-07-11T00:00:00.000Z';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const user = {
  id: USER_ID,
  username: 'mobile',
  displayName: 'Mobile',
  createdAt: NOW,
  lastLoginAt: NOW,
  isActive: true,
};
const node = {
  id: NODE_ID,
  name: 'A deliberately long mobile node name',
  kind: 'local',
  host: null,
  port: null,
  sshUser: null,
  sshKeyRef: null,
  sshAuthMethod: null,
  pool: null,
  connectionStatus: 'connected',
  lastSeenAt: NOW,
  createdBy: USER_ID,
  createdAt: NOW,
};
const project = {
  id: PROJECT_ID,
  nodeId: NODE_ID,
  name: 'A deliberately long project name',
  workingDir: '/workspace/a-very-long-project-directory',
  agentPolicy: {
    defaultAuthority: 'callback_only',
    maxAuthority: 'manage',
    maxConcurrentAgents: 12,
    spawnRateLimitPerMinute: 10,
    maxSendBytes: 16384,
    maxReadMessages: 100,
  },
  createdAt: NOW,
};
const session = {
  id: SESSION_ID,
  nodeId: NODE_ID,
  projectId: PROJECT_ID,
  agentType: 'claude-code',
  tmuxSessionName: 'flock-test',
  workingDir: project.workingDir,
  hookTokenHash: 'hash',
  status: 'running',
  statusDetail: null,
  note: 'Mobile agent',
  permissionMode: 'default',
  orchestrationAuthority: 'callback_only',
  createdAt: NOW,
  lastStatusAt: NOW,
  createdBy: USER_ID,
  closedAt: null,
};

function apiBody(path: string): unknown {
  if (path === '/api/diagnostics') return diagnosticsFixture(NOW);
  if (path === '/api/auth/me') return { user };
  if (path === '/api/auth/status')
    return {
      setupRequired: false,
      setupTokenRequired: false,
      deployment: { mode: 'builtin-tls', transport: 'https', warning: null },
    };
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
        updatedAt: null,
        nodeOrder: [],
        sessionOrder: {},
        layoutPresets: [],
      },
    };
  }
  if (path === `/api/projects/${PROJECT_ID}/pens`) return { pens: null, revision: 0 };
  if (path === `/api/nodes/${NODE_ID}/info`) {
    return {
      hostname: 'mobile-test-host-with-a-long-name',
      os: 'Linux',
      kernel: '6.8.0-test',
      cores: 8,
      uptimeSec: 86_400,
      load1: 0.5,
      load5: 0.4,
      load15: 0.3,
      cpuPercent: 25,
      memTotal: 16_000_000_000,
      memUsed: 8_000_000_000,
      diskTotal: 100_000_000_000,
      diskUsed: 50_000_000_000,
      agents: [{ name: 'claude', version: '1.0', path: '/usr/local/bin/claude' }],
      processes: { [SESSION_ID]: { rssBytes: 100_000_000, cpuPct: 12 } },
    };
  }
  if (path === `/api/sessions/${SESSION_ID}/git/status`) {
    return {
      sessionId: SESSION_ID,
      branch: 'feature/a-very-long-mobile-branch-name',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      hasHead: true,
      files: [
        {
          path: 'src/a/very/long/path/to/a/changed-file.ts',
          origPath: null,
          indexStatus: '.',
          worktreeStatus: 'M',
          staged: false,
          unstaged: true,
          kind: 'modified',
        },
      ],
      generatedAt: NOW,
    };
  }
  if (path === `/api/nodes/${NODE_ID}/stack`) {
    return { nodeId: NODE_ID, path: project.workingDir, stacks: [], gitRepo: true };
  }
  return {};
}

async function installMobileMocks(page: Page, authenticated = true): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    const expectedAuthProbe = !authenticated && text.includes('401 (Unauthorized)');
    const expectedWebKitViewportWarning = text.includes(
      'Viewport argument key "interactive-widget" not recognized and ignored.',
    );
    if (
      message.type() === 'error' &&
      !text.includes('WebSocket') &&
      !expectedAuthProbe &&
      !expectedWebKitViewportWarning
    ) {
      errors.push(text);
    }
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me' && !authenticated) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(apiBody(path)),
    });
  });
  await page.routeWebSocket('**/ws/**', (socket) => {
    socket.onMessage(() => undefined);
  });
  return errors;
}

async function expectMobilePage(page: Page, path: string, selector: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator(selector)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  const dimensions = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    rectWidth: element.getBoundingClientRect().width,
  }));
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(dimensions.clientWidth).toBe(viewportWidth);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(viewportWidth);
  expect(dimensions.rectWidth).toBe(viewportWidth);
  await expect(page.getByText('Something went wrong!', { exact: true })).toHaveCount(0);
}

test('all authenticated mobile pages fit the visual viewport without crashing', async ({
  page,
}) => {
  const errors = await installMobileMocks(page);
  await expectMobilePage(page, '/', '[data-testid="phone-view"]');
  await expectMobilePage(page, '/agents', '[data-testid="phone-view"]');
  await expectMobilePage(page, `/p/${PROJECT_ID}`, '[data-testid="phone-view"]');
  await expectMobilePage(page, `/agents/${SESSION_ID}`, '[data-testid="phone-stage"]');
  await expectMobilePage(page, `/n/${NODE_ID}`, '[data-testid="phone-node-details"]');
  await expectMobilePage(page, `/p/${PROJECT_ID}/git`, '[data-testid="phone-project-git"]');
  for (const section of [
    'appearance',
    'notifications',
    'nodes',
    'account',
    'operations',
    'about',
  ]) {
    await expectMobilePage(page, `/settings/${section}`, '[data-testid="phone-settings"]');
  }
  expect(errors).toEqual([]);
});

test('mobile dialogs stay inside the visual viewport', async ({ page }) => {
  const errors = await installMobileMocks(page);
  await expectMobilePage(page, '/', '[data-testid="phone-view"]');
  await page.getByRole('button', { name: 'Open mobile navigation' }).click();
  await page.getByText('Start new agent', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
  expect(errors).toEqual([]);
});

test('mobile Settings can add and edit nodes', async ({ page }) => {
  const errors = await installMobileMocks(page);
  await expectMobilePage(page, '/settings/nodes', '[data-testid="phone-settings"]');

  await page.getByRole('button', { name: 'Add node' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add node' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Edit node' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit node' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue(node.name);
  expect(errors).toEqual([]);
});

test('all mobile pages also fit a 320px-wide phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const errors = await installMobileMocks(page);
  await expectMobilePage(page, '/', '[data-testid="phone-view"]');
  await expectMobilePage(page, `/agents/${SESSION_ID}`, '[data-testid="phone-stage"]');
  await expectMobilePage(page, `/n/${NODE_ID}`, '[data-testid="phone-node-details"]');
  await expectMobilePage(page, `/p/${PROJECT_ID}/git`, '[data-testid="phone-project-git"]');
  for (const section of [
    'appearance',
    'notifications',
    'nodes',
    'account',
    'operations',
    'about',
  ]) {
    await expectMobilePage(page, `/settings/${section}`, '[data-testid="phone-settings"]');
  }
  expect(errors).toEqual([]);
});

test('mobile sign-in fits without horizontal overflow', async ({ page }) => {
  const errors = await installMobileMocks(page, false);
  await expectMobilePage(page, '/', '[data-testid="auth-screen"]');
  await expect(page.getByRole('form', { name: 'Log in' })).toBeVisible();
  expect(errors).toEqual([]);
});
