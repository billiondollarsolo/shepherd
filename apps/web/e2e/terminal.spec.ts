import { test, expect } from './flock-test';

/**
 * US-12 smoke: selecting a session mounts the chosen emulator (xterm.js per
 * docs/decisions/terminal.md) bound to `pty:<id>`; typing echoes; alt-screen
 * (vim/htop) works.
 *
 * The session-routing app shell (US-30/US-33) and a live orchestrator are not
 * available yet, so we mount the real <Terminal> via the in-repo harness
 * (src/features/terminal/harness.html → terminalHarness.tsx) served by the Vite
 * dev server, driven by a fake echoing PTY socket. Serving the HTML through Vite
 * (rather than a page.route-fulfilled body) is required so the React-refresh
 * preamble is injected and the module actually executes. This exercises the
 * exact production component + xterm rendering path, only stubbing the transport.
 */

/** The harness page is served by the dev server from the source tree. */
const HARNESS_URL = '/src/features/terminal/harness.html';

test('mounts xterm bound to pty:<id> and renders terminal output', async ({ page }) => {
  await page.goto(HARNESS_URL);

  // xterm.js mounted: its `.xterm` root + rows render inside our container.
  const term = page.getByTestId('terminal');
  await expect(term).toBeVisible();
  await expect(term.locator('.xterm')).toBeVisible();
  await expect(term.locator('.xterm-rows')).toBeVisible();

  // The fake socket opens → the connecting indicator disappears.
  await expect(page.getByTestId('terminal-status')).toHaveCount(0);

  // Server-pushed output renders in the terminal (PTY → xterm.write path).
  await page.evaluate(() => window.__ptyEmit('hello-from-pty\r\n'));
  await expect(term.locator('.xterm-rows')).toContainText('hello-from-pty');
});

test('typing echoes into the terminal', async ({ page }) => {
  await page.goto(HARNESS_URL);
  const term = page.getByTestId('terminal');
  await expect(term.locator('.xterm-rows')).toBeVisible();

  // Focus xterm's hidden input (the element it actually reads keystrokes from)
  // and enter text. xterm captures printable characters via the textarea's
  // `input` event, so `insertText` (which dispatches that event) faithfully
  // simulates typing; the harness PTY echoes the keystrokes back.
  await term.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('whoami');

  // Keystrokes were forwarded upstream (binary frames captured by the harness).
  await expect.poll(() => page.evaluate(() => window.__ptySent.join(''))).toContain('whoami');
  // And the echo rendered.
  await expect(term.locator('.xterm-rows')).toContainText('whoami');
});

test('alt-screen apps (vim/htop) render', async ({ page }) => {
  await page.goto(HARNESS_URL);
  const term = page.getByTestId('terminal');
  await expect(term.locator('.xterm-rows')).toBeVisible();

  // Enter the alternate screen buffer (CSI ?1049h) like vim/htop do, write some
  // content, then assert the emulator switched buffers and rendered it.
  await page.evaluate(() => {
    window.__ptyEmit('[?1049h'); // enable alt screen
    window.__ptyEmit('[2J[H'); // clear + home
    window.__ptyEmit('-- VIM ALT SCREEN --');
  });

  await expect(term.locator('.xterm-screen')).toBeVisible();
  await expect(term.locator('.xterm-rows')).toContainText('VIM ALT SCREEN');
});
