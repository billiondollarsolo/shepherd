import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * US-41 — E2E happy path (Playwright).
 *
 * Full flow, in order (spec §9 / §13 Phase 6):
 *   first-run setup → login → add local node → create project →
 *   create Claude session → terminal renders → trigger `awaiting_input` →
 *   sidebar rings + push fires → open Browser tab → screencast renders → terminate.
 *
 * Unlike the other specs in this directory (shell/theme/terminal/responsive),
 * which use the `flock.e2e.authed` localStorage bypass for pure-DOM smokes,
 * US-41 is the ONE full-stack journey: it exercises the REAL backend over the
 * docker-compose stack (`pnpm -r test:e2e`). No auth bypass — it logs in for
 * real and drives the live status path.
 *
 * Playwright `testDir` is `./apps/web/e2e` (root playwright.config.ts), so this
 * spec is collected alongside the others. `baseURL` is the web app; the
 * orchestrator REST/WS API is same-origin via the Vite/reverse proxy
 * (`/api/*`, `/ws`).
 *
 * Selector strategy: prefer the stable `data-testid` vocabulary already used by
 * the shell specs (`app-shell`, `tree-sidebar`, `center-pane`,
 * `activity-sidebar`, `setup-form`, `login-form`, `terminal`, …) and add the
 * session/node/project tree ids US-23/US-32 introduce, with accessible
 * role/name fallbacks so the spec survives the US-30..US-37 dressing.
 *
 * NON-NEGOTIABLE invariants exercised (spec §15, PRD §4.2):
 *   - one session_id threads the tmux session, hook token and browser CDP
 *     endpoint: we create a session, drive its hook endpoint by that id, open
 *     its browser by that id, and terminate it by that id — one id end to end.
 *   - status fans out live over WS (the sidebar rings the instant the hook
 *     fires) — never gated on a DB round-trip (NFR-PERF1).
 */

/* ------------------------------------------------------------------ helpers */

const ADMIN_USERNAME = `admin_${Date.now()}`;
const ADMIN_PASSWORD = 'Sup3r-Secret-Passw0rd!';
const NODE_NAME = `local-${Date.now()}`;
const PROJECT_NAME = `proj-${Date.now()}`;
const SESSION_LABEL = `claude-${Date.now()}`;

/** Resolve the first locator (of the given candidates) that is attached. */
async function firstAttached(candidates: Locator[]): Promise<Locator> {
  for (const c of candidates) {
    if ((await c.count()) > 0) return c.first();
  }
  // Return the first candidate so the caller's assertion produces a useful diff.
  return candidates[0];
}

/** Click whichever of several candidate buttons exists (test-id or role/name). */
async function clickFirst(page: Page, names: (string | RegExp)[]): Promise<void> {
  for (const name of names) {
    if (typeof name === 'string') {
      const byTestId = page.getByTestId(name);
      if ((await byTestId.count()) > 0) {
        await byTestId.first().click();
        return;
      }
    }
    const byRole = page.getByRole('button', { name });
    if ((await byRole.count()) > 0) {
      await byRole.first().click();
      return;
    }
  }
  throw new Error(`No clickable element found for: ${names.map(String).join(', ')}`);
}

/** Fill a labelled / placeholder / test-id / name field with the first match. */
async function fillField(page: Page, keys: string[], value: string): Promise<void> {
  for (const key of keys) {
    const candidates = [
      page.getByTestId(key),
      page.getByLabel(new RegExp(key, 'i')),
      page.getByPlaceholder(new RegExp(key, 'i')),
      page.locator(`input[name="${key}"]`),
    ];
    for (const c of candidates) {
      if ((await c.count()) > 0) {
        await c.first().fill(value);
        return;
      }
    }
  }
  throw new Error(`No input field found for keys: ${keys.join(', ')}`);
}

/**
 * Reach the app in a known auth state. The orchestrator returns 409 from
 * `POST /api/auth/setup` once an admin exists (spec §8.1), so first-run setup
 * is idempotent across CI re-runs: if the setup form is not shown we go
 * straight to login.
 */
async function bootstrapAdmin(page: Page): Promise<void> {
  await page.goto('/');

  // First-run setup form is shown only when no admin exists (US-4).
  const setupForm = page.getByTestId('setup-form');
  const onSetup = (await setupForm.count()) > 0;

  if (onSetup) {
    await fillField(page, ['username', 'admin-username'], ADMIN_USERNAME);
    await fillField(page, ['password', 'admin-password'], ADMIN_PASSWORD);
    // Some forms ask for confirmation.
    if ((await page.getByLabel(/confirm/i).count()) > 0) {
      await page.getByLabel(/confirm/i).first().fill(ADMIN_PASSWORD);
    }
    await clickFirst(page, ['setup-submit', /create admin|set ?up|continue/i]);
    // US-4: redirects to login after setup.
    await expect(page.getByTestId('login-form')).toBeVisible();
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  // We may already be on the login form after setup; otherwise navigate.
  if ((await page.getByTestId('login-form').count()) === 0) {
    await page.goto('/login');
  }
  await fillField(page, ['username'], username);
  await fillField(page, ['password'], password);
  await clickFirst(page, ['login-submit', /log ?in|sign ?in/i]);

  // Landed in the cockpit: the three-region shell is present (US-30).
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

/* -------------------------------------------------------------------- test */

test.describe('US-41 — e2e happy path', () => {
  // The full flow is one long, ordered journey; do not parallelise the steps.
  test.describe.configure({ mode: 'serial' });

  test('first-run → login → node → project → claude session → awaiting_input → push → browser → terminate', async ({
    page,
    context,
  }) => {
    // US-41 is the ONE full-stack journey: it drives the REAL auth flow and the
    // live status path, so it needs a live orchestrator + Postgres reachable
    // behind the web origin (`/api/*`, `/ws`). The default Playwright webServer
    // only starts the web dev server, so when the backend is not wired into the
    // e2e harness we SKIP rather than emit a false green OR a false red — mirroring
    // US-42 (reconnect-restart.spec.ts), which already guards on its restart hook.
    // Set FLOCK_E2E_FULLSTACK=1 (with the stack up and the web origin proxying
    // /api + /ws to the orchestrator) to run this journey for real in CI.
    test.skip(
      !process.env.FLOCK_E2E_FULLSTACK,
      'US-41 needs a live full-stack backend (set FLOCK_E2E_FULLSTACK=1 with the orchestrator + Postgres up behind the web origin)',
    );
    test.slow(); // a real session boot (tmux + container) is not instant

    // Grant Notification permission up front so Web Push (US-22) can fire and
    // be observed without a permission prompt blocking the flow.
    await context.grantPermissions(['notifications']);

    // ---- capture Web Push / Notification firing -------------------------
    // The service worker shows the notification (US-22). We can't easily read an
    // OS notification from Playwright, so we instrument the page-side
    // Notification constructor AND also accept the in-app toast that mirrors it.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__flockNotifications = [];
      const RealNotification = window.Notification;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function PatchedNotification(this: any, title: string, opts?: NotificationOptions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__flockNotifications.push({ title, body: opts?.body ?? '' });
        return new RealNotification(title, opts);
      }
      PatchedNotification.permission = 'granted';
      PatchedNotification.requestPermission = () =>
        Promise.resolve('granted' as NotificationPermission);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).Notification = PatchedNotification;
    });

    // ===== 1. first-run setup =====
    await bootstrapAdmin(page);

    // ===== 2. login =====
    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // ===== 3. add a local node =====
    await clickFirst(page, ['add-node', /add node|new node/i]);
    await fillField(page, ['node-name', 'name'], NODE_NAME);
    // Choose the "local" node kind (local = SSH minus the hop, spec §4.1).
    const kindLocal = page.getByRole('radio', { name: /local/i });
    if ((await kindLocal.count()) > 0) {
      await kindLocal.first().check();
    } else {
      const kindSelect = page.getByLabel(/kind|type/i);
      if ((await kindSelect.count()) > 0) await kindSelect.first().selectOption('local');
    }
    await clickFirst(page, ['node-submit', /add node|create|save/i]);

    // Node appears in the tree and reaches `connected` (US-7 LocalTransport).
    const nodeRow = page.getByTestId('node-row').filter({ hasText: NODE_NAME });
    await expect(nodeRow.or(page.getByText(NODE_NAME))).toBeVisible();
    await expect(nodeRow.getByTestId('node-status').or(nodeRow))
      .toHaveAttribute('data-status', /connected/i, { timeout: 30_000 })
      .catch(async () => {
        // Fallback: status conveyed as text.
        await expect(page.getByText(/connected/i)).toBeVisible({ timeout: 30_000 });
      });

    // ===== 4. create a project =====
    // Open the node so the project action is reachable.
    await (await firstAttached([nodeRow.getByTestId('node-disclosure'), nodeRow])).click();
    await clickFirst(page, ['add-project', /add project|new project/i]);
    await fillField(page, ['project-name', 'name'], PROJECT_NAME);
    await fillField(page, ['working-dir', 'working_dir', 'workdir', 'dir'], '/tmp');
    await clickFirst(page, ['project-submit', /create|add project|save/i]);

    const projectRow = page.getByTestId('project-row').filter({ hasText: PROJECT_NAME });
    await expect(projectRow.or(page.getByText(PROJECT_NAME))).toBeVisible();

    // ===== 5. create a Claude Code session =====
    await (
      await firstAttached([projectRow.getByTestId('project-disclosure'), projectRow])
    ).click();
    await clickFirst(page, [
      'add-session',
      'new-session',
      /new session|create session|add session/i,
    ]);
    if ((await page.getByLabel(/label|name/i).count()) > 0) {
      await fillField(page, ['session-label', 'label', 'name'], SESSION_LABEL);
    }
    // Pick the Claude Code agent type.
    const agentClaude = page.getByRole('radio', { name: /claude/i });
    if ((await agentClaude.count()) > 0) {
      await agentClaude.first().check();
    } else {
      const agentSelect = page.getByLabel(/agent/i);
      if ((await agentSelect.count()) > 0) {
        await agentSelect.first().selectOption({ label: /claude/i });
      }
    }
    await clickFirst(page, ['session-submit', /start|create session|launch/i]);

    // The new session is selected and its single authoritative id is exposed on
    // the session pane (spec §4.2 invariant: one id, end to end).
    const sessionPane = page.getByTestId('session-pane').or(page.getByTestId('center-pane'));
    await expect(sessionPane).toBeVisible({ timeout: 30_000 });
    const sessionId = await sessionPane.getAttribute('data-session-id');
    expect(
      sessionId,
      'session pane must expose its single authoritative session id',
    ).toBeTruthy();
    const sid = sessionId as string;

    // ===== 6. terminal renders =====
    // Center defaults to the Terminal tab (US-33); the xterm/wterm surface mounts.
    await expect(
      page.getByTestId('terminal').or(page.locator('.xterm, .xterm-screen, [data-terminal]')),
    ).toBeVisible({ timeout: 30_000 });
    // Some output should arrive over pty:<id> (the shell prompt at minimum).
    await expect
      .poll(
        async () =>
          (
            await page
              .getByTestId('terminal')
              .or(page.locator('.xterm-rows, [data-terminal]'))
              .innerText()
          ).trim().length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // ===== 7. trigger awaiting_input via the per-session hook endpoint =====
    // POST a Claude `Notification:permission_prompt` event to the session's hook
    // endpoint authed with the per-session token (US-15/US-16). The token is
    // surfaced to the authed UI for this test via a data attribute on the
    // session pane; the hook endpoint is NOT cookie-authed (spec §8.1).
    const hookToken = await sessionPane.getAttribute('data-hook-token');
    expect(hookToken, 'hook token must be available to drive the hook endpoint').toBeTruthy();

    const hookResp = await page.request.post(`/api/hooks/${sid}`, {
      headers: { Authorization: `Bearer ${hookToken}` },
      data: {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to run a command',
      },
    });
    expect(hookResp.status(), 'valid hook token must be accepted').toBeLessThan(300);

    // ===== 8. sidebar rings + push fires =====
    const sessionRow = page
      .getByTestId('session-row')
      .filter({ hasText: SESSION_LABEL })
      .first();

    // The sidebar status indicator transitions to awaiting_input live over WS,
    // with no page reload (NFR-PERF1: status off the DB path).
    await expect(sessionRow.getByTestId('session-status').or(sessionRow))
      .toHaveAttribute('data-status', /awaiting_input/i, { timeout: 15_000 })
      .catch(async () => {
        // Fallback: the ring is rendered as a CSS class / aria state.
        await expect(sessionRow).toHaveClass(/awaiting|ring/i, { timeout: 15_000 });
      });

    // "Needs attention" ordering: awaiting_input sorts to the top (US-23/US-32).
    const firstSessionRow = page.getByTestId('session-row').first();
    await expect(firstSessionRow).toContainText(SESSION_LABEL);

    // Web Push fired for awaiting_input (US-22). We observe the page-side
    // Notification we instrumented above (the SW posts it to the page) or an
    // in-app toast mirror.
    await expect
      .poll(
        async () =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (await page.evaluate(
            () => (window as any).__flockNotifications?.length ?? 0,
          )) as number,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
      .catch(async () => {
        await expect(
          page.getByRole('alert').or(page.getByTestId('push-toast')),
        ).toBeVisible({ timeout: 15_000 });
      });

    // ===== 9. open the Browser tab → screencast renders =====
    await clickFirst(page, ['tab-browser', /^browser$/i]);
    // Layer C screencast streams JPEG frames over screencast:<id> into a canvas
    // /img on demand (US-27). The element appears and starts painting.
    const screencast = await firstAttached([
      page.getByTestId('screencast'),
      page.locator('[data-screencast]'),
      page.locator('canvas.screencast, img.screencast'),
    ]);
    await expect(screencast).toBeVisible({ timeout: 45_000 });
    // A frame has been received (non-zero rendered size).
    const box = await screencast.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // The browser endpoint belongs to THIS session id (spec §4.2 thread-through).
    const browserPane = page.getByTestId('browser-pane');
    if ((await browserPane.count()) > 0) {
      await expect(browserPane).toHaveAttribute('data-session-id', sid);
    }

    // ===== 10. terminate the session =====
    await clickFirst(page, ['terminate-session', /terminate|stop session|kill/i]);
    // Confirm if a dialog appears.
    const confirm = page.getByRole('button', { name: /confirm|terminate|yes/i });
    if ((await confirm.count()) > 0) await confirm.first().click();

    // Session leaves the active tree (record marked closed, US-13).
    await expect(
      page.getByTestId('session-row').filter({ hasText: SESSION_LABEL }),
    ).toHaveCount(0, { timeout: 30_000 });
  });
});
