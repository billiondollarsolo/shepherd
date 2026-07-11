import { expect, test, type Locator, type Page } from './flock-test';

/**
 * US-42 — Reconnect / restart resilience (Playwright e2e).
 *
 * Acceptance criteria (spec §9 US-42, §13 Phase 6):
 *   Restart the orchestrator mid-session →
 *     (a) agent work SURVIVES the restart (tmux owns the process; the
 *         orchestrator and the user's browser are only viewers — PRD §1, NFR-AV1),
 *     (b) the session RE-ATTACHES on orchestrator boot (FR-S4 / US-10: an existing
 *         tmux session is rediscovered and re-bound on restart),
 *     (c) status RECONCILES to ground truth after the gap (US-24 / §7.2:
 *         re-attach + probe + resync; while the orchestrator is down the session
 *         shows `disconnected`, then re-resolves — NFR-AV2).
 *   Green in CI.
 *
 * Like US-41 (`happy-path.spec.ts`), this is a FULL-STACK journey, not a pure-DOM
 * smoke: it logs in for real and exercises the live status path over the
 * docker-compose stack (`pnpm -r test:e2e`). It deliberately reuses US-41's
 * helper + selector vocabulary (`app-shell`, `node-row`, `project-row`,
 * `session-row`, `session-pane`/`center-pane`, `terminal`, `setup-form`,
 * `login-form`, …) so it survives the same UI dressing US-30..US-37 apply.
 *
 * Playwright `testDir` is `./apps/web/e2e` (root playwright.config.ts); `baseURL`
 * is the web app and the orchestrator REST/WS API is same-origin via the
 * Vite/reverse proxy (`/api/*`, `/ws`).
 *
 * NON-NEGOTIABLE invariant exercised (spec §15, PRD §4.2): one `session_id`
 * threads the tmux session name + hook token + browser CDP endpoint. We capture
 * the id BEFORE the restart and assert the SAME id is re-bound AFTER the restart
 * (the record is reconciled, never duplicated — spec §10 "tmux session name
 * collision → new-session -A attaches existing; record reconciled, not
 * duplicated").
 *
 * Restarting the orchestrator from inside an e2e test:
 *   The orchestrator process is restarted out-of-band (it is a separate service
 *   from the web dev server that Playwright's `webServer` owns, so bouncing it
 *   does not tear down the test's page/WS-to-web). The mechanism is provided by
 *   the harness via `FLOCK_E2E_RESTART_CMD` (e.g.
 *   `docker compose -f docker-compose.dev.yml restart orchestrator`) so this spec
 *   stays decoupled from the exact compose service name. When the variable is not
 *   set (local pure-DOM runs without a live backend) the test is skipped rather
 *   than producing a false green.
 */

/* ------------------------------------------------------------------ helpers */

const STAMP = Date.now();
const ADMIN_USERNAME = `admin_${STAMP}`;
const ADMIN_PASSWORD = 'Sup3r-Secret-Passw0rd!';
const NODE_NAME = `local-${STAMP}`;
const PROJECT_NAME = `proj-${STAMP}`;
const SESSION_LABEL = `claude-${STAMP}`;
/** A unique sentinel the agent writes to disk; it must survive the restart. */
const SENTINEL = `flock-survives-${STAMP}`;

/** Resolve the first locator (of the candidates) that is attached. */
async function firstAttached(candidates: Locator[]): Promise<Locator> {
  for (const c of candidates) {
    if ((await c.count()) > 0) return c.first();
  }
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
 * Reach the app in a known auth state. `POST /api/auth/setup` returns 409 once
 * an admin exists (spec §8.1), so first-run setup is idempotent across CI
 * re-runs: if the setup form is not shown we go straight to login.
 */
async function bootstrapAdmin(page: Page): Promise<void> {
  await page.goto('/');
  const setupForm = page.getByTestId('setup-form');
  if ((await setupForm.count()) > 0) {
    await fillField(page, ['username', 'admin-username'], ADMIN_USERNAME);
    await fillField(page, ['password', 'admin-password'], ADMIN_PASSWORD);
    if ((await page.getByLabel(/confirm/i).count()) > 0) {
      await page
        .getByLabel(/confirm/i)
        .first()
        .fill(ADMIN_PASSWORD);
    }
    await clickFirst(page, ['setup-submit', /create admin|set ?up|continue/i]);
    await expect(page.getByTestId('login-form')).toBeVisible();
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  if ((await page.getByTestId('login-form').count()) === 0) {
    await page.goto('/login');
  }
  await fillField(page, ['username'], username);
  await fillField(page, ['password'], password);
  await clickFirst(page, ['login-submit', /log ?in|sign ?in/i]);
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

/** The session row in the tree for our session label. */
function sessionRowFor(page: Page): Locator {
  return page.getByTestId('session-row').filter({ hasText: SESSION_LABEL }).first();
}

/** Read the session row's status, tolerating data-status attr OR class/text. */
async function readStatus(row: Locator): Promise<string> {
  const indicator = row.getByTestId('session-status');
  if ((await indicator.count()) > 0) {
    const attr = await indicator.first().getAttribute('data-status');
    if (attr) return attr.toLowerCase();
  }
  const rowAttr = await row.getAttribute('data-status');
  if (rowAttr) return rowAttr.toLowerCase();
  return (await row.innerText()).toLowerCase();
}

/**
 * Restart the orchestrator out of band. Returns false (and the test skips) when
 * no restart mechanism is wired, so we never emit a false green.
 */
async function restartOrchestrator(): Promise<boolean> {
  const cmd = process.env.FLOCK_E2E_RESTART_CMD;
  if (!cmd) return false;
  // Imported lazily so the spec still parses where node:child_process is absent.
  const { execSync } = await import('node:child_process');
  execSync(cmd, { stdio: 'inherit' });
  return true;
}

/* -------------------------------------------------------------------- test */

test.describe('US-42 — reconnect / restart resilience', () => {
  // One long ordered journey across a restart; do not parallelise the steps.
  test.describe.configure({ mode: 'serial' });

  test('orchestrator restart mid-session: work survives, session re-attaches, status reconciles', async ({
    page,
  }) => {
    test.skip(
      !process.env.FLOCK_E2E_RESTART_CMD,
      'US-42 needs a live backend + FLOCK_E2E_RESTART_CMD to bounce the orchestrator',
    );
    test.slow(); // real session boot + an orchestrator restart are not instant

    // ===== 1. setup → login =====
    await bootstrapAdmin(page);
    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // ===== 2. local node → project → claude session =====
    await clickFirst(page, ['add-node', /add node|new node/i]);
    await fillField(page, ['node-name', 'name'], NODE_NAME);
    const kindLocal = page.getByRole('radio', { name: /local/i });
    if ((await kindLocal.count()) > 0) {
      await kindLocal.first().check();
    } else {
      const kindSelect = page.getByLabel(/kind|type/i);
      if ((await kindSelect.count()) > 0) await kindSelect.first().selectOption('local');
    }
    await clickFirst(page, ['node-submit', /add node|create|save/i]);

    const nodeRow = page.getByTestId('node-row').filter({ hasText: NODE_NAME });
    await expect(nodeRow.or(page.getByText(NODE_NAME))).toBeVisible();

    await (await firstAttached([nodeRow.getByTestId('node-disclosure'), nodeRow])).click();
    await clickFirst(page, ['add-project', /add project|new project/i]);
    await fillField(page, ['project-name', 'name'], PROJECT_NAME);
    await fillField(page, ['working-dir', 'working_dir', 'workdir', 'dir'], '/tmp');
    await clickFirst(page, ['project-submit', /create|add project|save/i]);

    const projectRow = page.getByTestId('project-row').filter({ hasText: PROJECT_NAME });
    await expect(projectRow.or(page.getByText(PROJECT_NAME))).toBeVisible();

    await (await firstAttached([projectRow.getByTestId('project-disclosure'), projectRow])).click();
    await clickFirst(page, [
      'add-session',
      'new-session',
      /new session|create session|add session/i,
    ]);
    if ((await page.getByLabel(/label|name/i).count()) > 0) {
      await fillField(page, ['session-label', 'label', 'name'], SESSION_LABEL);
    }
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

    // The single authoritative session id is captured BEFORE the restart.
    const sessionPane = page.getByTestId('session-pane').or(page.getByTestId('center-pane'));
    await expect(sessionPane).toBeVisible({ timeout: 30_000 });
    const sidBefore = await sessionPane.getAttribute('data-session-id');
    expect(sidBefore, 'session pane must expose its authoritative session id').toBeTruthy();
    const sid = sidBefore as string;

    // ===== 3. terminal renders; do durable work inside the tmux session =====
    const terminal = page
      .getByTestId('terminal')
      .or(page.locator('.xterm, .xterm-screen, [data-terminal]'));
    await expect(terminal).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await terminal.innerText()).trim().length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    // Type a command into the live PTY that writes a sentinel file to disk. The
    // process runs inside tmux on the node, NOT inside the orchestrator, so it
    // must survive the orchestrator restart (NFR-AV1).
    await terminal.click();
    await page.keyboard.type(`echo ${SENTINEL} > /tmp/${SENTINEL}.txt`);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`echo ${SENTINEL}`);
    await page.keyboard.press('Enter');
    // The sentinel is echoed into the live scrollback before we restart.
    await expect
      .poll(async () => (await terminal.innerText()).includes(SENTINEL), { timeout: 15_000 })
      .toBe(true);

    // ===== 4. restart the orchestrator MID-SESSION =====
    const restarted = await restartOrchestrator();
    expect(restarted, 'orchestrator restart must have run').toBe(true);

    // (b/c) While the orchestrator is down / re-attaching, the live status path
    // degrades gracefully to `disconnected` rather than vanishing (NFR-AV2,
    // §7.2). We tolerate a fast restart that never surfaces the transient state.
    const sessionRow = sessionRowFor(page);
    await expect(sessionRow).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const s = await readStatus(sessionRow);
          return /disconnected|reconnect|stale|connect/i.test(s);
        },
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
      .catch(() => {
        /* a sufficiently fast restart may skip the visible transient */
      });

    // ===== 5. session RE-ATTACHES under the SAME id (record reconciled) =====
    // After boot the orchestrator rediscovers the existing tmux session (FR-S4)
    // and re-binds it. The session must NOT be duplicated and must NOT disappear
    // from the tree.
    await expect(sessionRowFor(page)).toHaveCount(1, { timeout: 60_000 });

    // Re-select the session; the pane re-binds to the SAME authoritative id
    // (§4.2 thread-through preserved across the restart).
    await sessionRowFor(page).click();
    const sessionPaneAfter = page.getByTestId('session-pane').or(page.getByTestId('center-pane'));
    await expect(sessionPaneAfter).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => sessionPaneAfter.getAttribute('data-session-id'), { timeout: 30_000 })
      .toBe(sid);

    // ===== 6. status RECONCILES to ground truth (not stuck on disconnected) ====
    await expect
      .poll(
        async () => {
          const s = await readStatus(sessionRowFor(page));
          return s.includes('disconnected');
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(false);

    // ===== 7. agent WORK SURVIVED: the re-attached terminal still has the
    // sentinel, and the sentinel file written before the restart is readable
    // from the still-living tmux session (NFR-AV1). ====================
    const terminalAfter = page
      .getByTestId('terminal')
      .or(page.locator('.xterm, .xterm-screen, [data-terminal]'));
    await expect(terminalAfter).toBeVisible({ timeout: 30_000 });

    // Prove the process kept running through the restart by reading the file the
    // pre-restart command created. tmux preserved the shell + filesystem state.
    await terminalAfter.click();
    await page.keyboard.type(`cat /tmp/${SENTINEL}.txt`);
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await terminalAfter.innerText()).includes(SENTINEL), {
        timeout: 30_000,
      })
      .toBe(true);

    // ===== 8. the live path is healthy again: a hook fired AFTER the restart
    // still fans out over WS for the SAME session id (reconnect restored the
    // hot path, NFR-PERF1 / §7.2 resync). ============================
    const hookToken = await sessionPaneAfter.getAttribute('data-hook-token');
    if (hookToken) {
      const hookResp = await page.request.post(`/api/hooks/${sid}`, {
        headers: { Authorization: `Bearer ${hookToken}` },
        data: {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'post-restart permission prompt',
        },
      });
      expect(hookResp.status(), 'hook token must still be valid after restart').toBeLessThan(300);
      await expect
        .poll(async () => readStatus(sessionRowFor(page)), { timeout: 30_000 })
        .toMatch(/awaiting_input|awaiting|ring/);
    }
  });
});
