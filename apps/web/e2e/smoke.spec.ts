import { test, expect } from './flock-test';

test('paddock shell renders the Flock wordmark', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flock home' })).toBeVisible();
});
