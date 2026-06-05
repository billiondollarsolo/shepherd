import { expect, test, type Page } from '@playwright/test';

/**
 * US-31 dual-theme Playwright smoke (acceptance: "Verify in browser, both themes").
 *
 * Verifies the flock-theme acceptance criteria end-to-end against the running
 * web app:
 *   - OS preference auto-detect on first load (emulate prefers-color-scheme).
 *   - Toggling to dark sets data-theme="dark" on <html> and re-themes every
 *     surface; the choice persists across a reload and overrides the OS pref.
 *   - All theming is driven by the flock-theme tokens (apps/web/src/theme/tokens.ts):
 *     the resolved `--flock-surface-0` custom property is #ffffff (light) /
 *     #0f1115 (dark).
 *
 * We assert on the resolved CSS variable rather than the element's
 * `background-color`: theme.css applies a 120ms background-color transition, and
 * Chromium reports composited mid-transition rgba() values (e.g.
 * `rgba(255,255,255,0.47)`), which makes a raw background-color assertion flaky.
 * The custom-property value is updated instantly and is the true source of the
 * surface colour.
 *
 * The toggle is located by data-testid="theme-toggle" (ThemeToggle), mounted by
 * main.tsx.
 */

const SURFACE0_LIGHT = '#ffffff';
const SURFACE0_DARK = '#0f1115';

/** Resolved value of the surface.0 token — the canonical "what theme am I" signal. */
async function surface0(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--flock-surface-0').trim(),
  );
}

async function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

test.describe('flock-theme: light + dark (US-31)', () => {
  test('auto-picks dark when OS prefers dark (no stored choice)', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('dark');
    expect(await surface0(page)).toBe(SURFACE0_DARK);
    await ctx.close();
  });

  test('auto-picks light when OS prefers light (no stored choice)', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);
    await ctx.close();
  });

  test('toggle to dark re-themes surfaces and persists across reload', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto('/');

    // Start light.
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);

    // Toggle -> dark (the toggle flips relative to the visible theme).
    await page.getByTestId('theme-toggle').click();
    await expect.poll(() => dataTheme(page)).toBe('dark');
    expect(await surface0(page)).toBe(SURFACE0_DARK);

    // Persisted across reload (even though the OS still prefers light).
    await page.reload();
    await expect.poll(() => dataTheme(page)).toBe('dark');
    expect(await surface0(page)).toBe(SURFACE0_DARK);

    await ctx.close();
  });

  test('explicit choice overrides the OS preference', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('dark');

    // User picks light explicitly; overrides OS dark and persists.
    await page.getByTestId('theme-toggle').click();
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);
    await page.reload();
    await expect.poll(() => dataTheme(page)).toBe('light');

    await ctx.close();
  });
});
