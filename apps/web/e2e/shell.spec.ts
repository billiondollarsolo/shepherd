import { test, expect } from '@playwright/test';

/**
 * US-30 smoke — Codex-style three-region shell + keyboard model (Appendix A.1/A.2).
 *
 *  - The three regions render (tree | session | activity).
 *  - Cmd+K opens the command palette.
 *  - Cmd+J toggles the bottom shell drawer.
 *
 * Uses Meta+ (mac) which the app also accepts as Ctrl+; the chromium project
 * runs headless in the dev image. The bottom drawer is absent until toggled.
 */
test('renders the three cockpit regions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('region-tree')).toBeVisible();
  await expect(page.getByTestId('region-session')).toBeVisible();
  await expect(page.getByTestId('region-activity')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flock' })).toBeVisible();
});

test('Cmd+K opens the command palette', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);

  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();

  // Escape dismisses it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /command palette/i })).toHaveCount(0);
});

test('Cmd+J toggles the bottom shell drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('region-drawer')).toHaveCount(0);

  await page.keyboard.press('Meta+j');
  await expect(page.getByTestId('region-drawer')).toBeVisible();

  await page.keyboard.press('Meta+j');
  await expect(page.getByTestId('region-drawer')).toHaveCount(0);
});
