import { test, expect, devices } from '@playwright/test';

/**
 * US-36 (FR-UI6) — responsive collapse + installable PWA, verified at a mobile
 * viewport (spec line 340: "Verify in browser at mobile viewport").
 */

test.describe('phone viewport — which-agent-needs-me away view', () => {
  test.use({ viewport: devices['iPhone 13'].viewport });

  test('collapses to the single-column phone away view', async ({ page }) => {
    await page.goto('/');
    // The phone surface is shown and the dense desktop three-region shell is not.
    await expect(page.getByTestId('phone-view')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Flock' })).toBeVisible();
  });
});

test.describe('desktop viewport — full cockpit', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps the three-region desktop cockpit on a wide screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('phone-view')).toHaveCount(0);
  });
});

test.describe('installable PWA', () => {
  test('serves a valid web app manifest with standalone display', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    const sizes = (manifest.icons as Array<{ sizes: string }>).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  test('links the manifest and a theme-color from the document', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#0f1115',
    );
  });

  test('registers a service worker (Web Push + offline shell)', async ({ page }) => {
    await page.goto('/');
    // main.tsx fires registerServiceWorker() on load; wait for it to settle.
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg);
    });
    expect(registered).toBeTruthy();
  });
});
