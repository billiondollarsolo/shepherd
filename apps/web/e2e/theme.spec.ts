import { expect, test, type Page } from './flock-test';

const SURFACE0_LIGHT = '#ffffff';
const SURFACE0_DARK = '#0d0d0f';
const THEME_STORAGE_KEY = 'flock.theme';

async function surface0(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--flock-surface-0').trim(),
  );
}

async function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

test.describe('Shepherd dark-first theme', () => {
  test('defaults to dark even when the OS prefers light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('dark');
    expect(await surface0(page)).toBe(SURFACE0_DARK);
  });

  test('toggle to light re-themes surfaces and persists across reload', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('dark');

    await page.getByTestId('theme-toggle').click();
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);

    await page.reload();
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);
  });

  test('a stored explicit choice overrides the OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
      THEME_STORAGE_KEY,
      'light',
    ] as const);
    await page.goto('/');
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await surface0(page)).toBe(SURFACE0_LIGHT);
  });
});
