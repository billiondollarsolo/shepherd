import { expect, test } from './flock-test';

const VIEWPORTS = [
  { name: 'phone portrait', width: 390, height: 844, mobile: true },
  { name: 'phone landscape', width: 844, height: 390, mobile: false },
  { name: 'tablet', width: 768, height: 1024, mobile: false },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;

for (const viewport of VIEWPORTS) {
  test(`Shepherd wordmark fits ${viewport.name}`, async ({ page, browserName }) => {
    test.skip(browserName === 'webkit' && !viewport.mobile, 'desktop matrix runs in Chromium');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    const wordmark = viewport.mobile
      ? page.getByRole('heading', { name: 'Shepherd' })
      : page.getByRole('button', { name: 'Shepherd home' });
    await expect(wordmark).toBeVisible();
    if (!viewport.mobile) await expect(page.getByText('Shepherd Your Agents')).toBeVisible();

    const bounds = await wordmark.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('collapsed desktop rail keeps Shepherd identity and version accessible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  const version = page.getByText(/^v\d+\.\d+\.\d+/);
  await expect(version).toBeVisible();
  await version.hover();
  await expect(page.getByRole('tooltip')).toContainText(/^Shepherd \d+\.\d+\.\d+/);
});
