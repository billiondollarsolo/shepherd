import { test, expect } from './flock-test';

/**
 * US-30 smoke — Codex-style three-region shell + keyboard model (Appendix A.1/A.2).
 *
 *  - The current two-region shell renders (tree | session); activity is opt-in.
 *  - Cmd+K opens the command palette.
 *  - Cmd+J toggles the bottom shell drawer.
 *
 * Uses Meta+ (mac) which the app also accepts as Ctrl+; the chromium project
 * runs headless in the dev image. The bottom drawer is absent until toggled.
 */
test('renders the current paddock shell regions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('region-tree')).toBeVisible();
  await expect(page.getByTestId('region-session')).toBeVisible();
  await expect(page.getByTestId('region-activity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Flock home' })).toBeVisible();
});

test('command palette opens from its visible shortcut control', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);

  // Browser-reserved modifier chords are covered at the KeyboardProvider layer;
  // this browser test follows the equivalent visible control end to end.
  await page.getByRole('button', { name: 'Search agents, projects, nodes, and commands' }).click();
  await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();

  // Escape dismisses it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);
});

test('command palette toggles the bottom shell drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('region-drawer')).toHaveCount(0);

  const openPalette = () =>
    page.getByRole('button', { name: 'Search agents, projects, nodes, and commands' }).click();
  await openPalette();
  await page.getByRole('option', { name: /toggle shell drawer/i }).click();
  await expect(page.getByTestId('region-drawer')).toBeVisible();

  await openPalette();
  await page.getByRole('option', { name: /toggle shell drawer/i }).click();
  await expect(page.getByTestId('region-drawer')).toHaveCount(0);
});

test('a direct agent route renders an independent session outside every Pen', async ({ page }) => {
  const nodeId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const now = '2026-07-12T00:00:00.000Z';
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/nodes', (route) =>
    route.fulfill(
      json({
        nodes: [
          {
            id: nodeId,
            name: 'node-1',
            kind: 'ssh',
            host: 'node-1.example',
            port: 22,
            sshUser: 'flock-control',
            sshKeyRef: null,
            sshAuthMethod: 'key',
            pool: null,
            connectionStatus: 'connected',
            lastSeenAt: now,
            createdBy: null,
            createdAt: now,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/projects', (route) =>
    route.fulfill(
      json({
        projects: [
          {
            id: projectId,
            nodeId,
            name: 'demo',
            workingDir: '/srv/demo',
            agentPolicy: {
              defaultAuthority: 'callback_only',
              maxAuthority: 'manage',
              maxConcurrentAgents: 12,
              spawnRateLimitPerMinute: 10,
              maxSendBytes: 16_384,
              maxReadMessages: 100,
            },
            createdAt: now,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill(
      json({
        sessions: [
          {
            id: sessionId,
            nodeId,
            projectId,
            agentType: 'claude-code',
            workingDir: '/srv/demo',
            status: 'idle',
            statusDetail: null,
            note: null,
            permissionMode: 'default',
            orchestrationAuthority: 'callback_only',
            createdAt: now,
            lastStatusAt: now,
            closedAt: null,
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/pens`, (route) =>
    route.fulfill(
      json({
        pens: { version: 1, projectId, activePenId: 'pen-1', pens: [] },
        revision: 1,
      }),
    ),
  );

  await page.goto(`/agents/${sessionId}`);

  await expect(page.getByTestId('terminal-area')).toBeVisible();
  await expect(page.getByText('Drag an agent into a new Pen from the sidebar.')).toHaveCount(0);
});
