import { test, expect } from '@playwright/test';

test('cockpit shell renders the Flock title', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Flock' })).toBeVisible();
});
