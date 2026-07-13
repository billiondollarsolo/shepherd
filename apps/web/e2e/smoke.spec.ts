import { test, expect } from './flock-test';

test('paddock shell renders the Shepherd wordmark', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shepherd home' })).toBeVisible();
});
