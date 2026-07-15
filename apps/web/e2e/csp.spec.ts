import { expect, test } from './flock-test';

declare global {
  interface Window {
    __flockInlineExecuted?: boolean;
    __flockExternalExecuted?: boolean;
  }
}

test.describe('production content security policy', () => {
  test.skip(!process.env.E2E_CSP_BASE_URL, 'requires an edge-served CSP fixture');

  test('blocks injected inline script while allowing same-origin modules', async ({ page }) => {
    const response = await page.goto(process.env.E2E_CSP_BASE_URL!);
    expect(response?.status()).toBe(200);
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");

    await expect.poll(() => page.evaluate(() => window.__flockExternalExecuted)).toBe(true);
    expect(await page.evaluate(() => window.__flockInlineExecuted)).toBeUndefined();
  });
});
