import { expect, test, type Page } from '@playwright/test';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const policy = {
  defaultAuthority: 'callback_only',
  maxAuthority: 'manage',
  maxConcurrentAgents: 12,
  spawnRateLimitPerMinute: 10,
  maxSendBytes: 16384,
  maxReadMessages: 100,
};

async function mockFlock(page: Page, createdBodies: Array<Record<string, unknown>>): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') {
      return json({
        user: {
          id: USER_ID,
          username: 'operator',
          displayName: 'Operator',
          createdAt: '2026-07-11T00:00:00.000Z',
          lastLoginAt: null,
          isActive: true,
        },
      });
    }
    if (path === '/api/nodes') {
      return json({
        nodes: [
          {
            id: NODE_ID,
            name: 'workstation',
            kind: 'local',
            host: null,
            port: null,
            sshUser: null,
            sshKeyRef: null,
            sshAuthMethod: null,
            pool: null,
            connectionStatus: 'connected',
            lastSeenAt: null,
            createdBy: USER_ID,
            createdAt: '2026-07-11T00:00:00.000Z',
          },
        ],
      });
    }
    if (path === '/api/projects') {
      return json({
        projects: [
          {
            id: PROJECT_ID,
            nodeId: NODE_ID,
            name: 'policy-project',
            workingDir: '/workspace/project',
            agentPolicy: policy,
            createdAt: '2026-07-11T00:00:00.000Z',
          },
        ],
      });
    }
    if (path === '/api/sessions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      createdBodies.push(body);
      return json(
        {
          session: {
            id: SESSION_ID,
            nodeId: NODE_ID,
            projectId: PROJECT_ID,
            agentType: body.agentType,
            workingDir: '/workspace/project',
            status: 'starting',
            statusDetail: null,
            note: null,
            permissionMode: 'default',
            orchestrationAuthority: body.orchestrationAuthority ?? 'callback_only',
            createdAt: '2026-07-11T00:00:00.000Z',
            lastStatusAt: '2026-07-11T00:00:00.000Z',
            closedAt: null,
          },
        },
        201,
      );
    }
    if (path === '/api/sessions') return json({ sessions: [] });
    if (path === `/api/nodes/${NODE_ID}/info`) {
      return json({
        hostname: 'workstation',
        os: 'linux',
        kernel: '6.8',
        cpuPercent: 1,
        cores: 8,
        memTotal: 1,
        memUsed: 0,
        diskTotal: 1,
        diskUsed: 0,
        load1: 0,
        load5: 0,
        load15: 0,
        uptimeSec: 10,
        agents: [{ name: 'claude', path: '/usr/bin/claude', version: 'latest' }],
      });
    }
    if (path === '/api/agentd/status') return json({ enabled: true, nodes: {}, sessions: {} });
    if (path === '/api/activity/fleet') return json({ events: [] });
    if (path === '/api/chats/latest') return json({ chats: {} });
    if (path === '/api/teams') return json({ edges: [] });
    if (path === '/api/me/launcher-presets') return json({ presets: [] });
    return json({});
  });
}

async function openSessionDialog(page: Page): Promise<void> {
  await page.goto('/');
  // Included in assertion diagnostics if the mocked shell fails to hydrate.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByText('policy-project')).toBeVisible();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New session' }).click();
  await expect(page.getByRole('dialog', { name: 'Start session' })).toBeVisible();
}

test('session creation defaults to callback-only authority', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  await mockFlock(page, bodies);
  await openSessionDialog(page);
  await expect(page.getByLabel('Flock authority')).toContainText(/Project default — Independent/);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty('orchestrationAuthority');
});

test('manage authority requires explicit destructive confirmation', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  await mockFlock(page, bodies);
  await openSessionDialog(page);
  await page.getByLabel('Flock authority').click();
  await page.getByRole('option', { name: /Manage/ }).click();
  const start = page.getByRole('button', { name: 'Start session' });
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox').check();
  await start.click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ orchestrationAuthority: 'manage' });
});
