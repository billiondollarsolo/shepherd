/**
 * US-36 — installable PWA: the Web App Manifest + its document wiring.
 *
 * FR-UI6 / spec line 340: "installable PWA with service worker". For a browser to
 * offer "Add to Home Screen" the app must ship a manifest with the install-gating
 * fields (name, start_url, a `standalone` display mode, and a 192px + 512px
 * icon), and the document must link that manifest and declare a theme-color. We
 * assert the manifest file and `index.html` directly so the install affordance
 * cannot silently regress.
 *
 * Pure file/JSON assertions — runs under `pnpm test:unit` with no DOM or server.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');

function readJson(relPath: string): Record<string, unknown> {
  const raw = readFileSync(resolve(webRoot, relPath), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function readText(relPath: string): string {
  return readFileSync(resolve(webRoot, relPath), 'utf8');
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}

describe('PWA manifest (US-36, FR-UI6)', () => {
  const manifest = readJson('public/manifest.webmanifest');

  it('is valid JSON with a human and a short name', () => {
    expect(typeof manifest.name).toBe('string');
    expect((manifest.name as string).length).toBeGreaterThan(0);
    expect(typeof manifest.short_name).toBe('string');
    // iOS/Android home-screen labels are short — keep it tight.
    expect((manifest.short_name as string).length).toBeLessThanOrEqual(12);
  });

  it('starts at the paddock root in standalone display (installable)', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('uses the flock-theme dark surface for theme + background colors', () => {
    // Matches tokens.darkTheme.surface[0] (#06090d, the deep Orca-like charcoal)
    // so the splash/chrome is on-brand and there is no white flash on launch.
    expect(manifest.theme_color).toBe('#06090d');
    expect(manifest.background_color).toBe('#06090d');
  });

  it('ships the install-gating icon sizes (192 + 512) and a maskable icon', () => {
    const icons = manifest.icons as ManifestIcon[];
    expect(Array.isArray(icons)).toBe(true);
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(icons.some((i) => (i.purpose ?? '').includes('maskable'))).toBe(true);
  });

  it('references icon files under /icons (served from public/)', () => {
    const icons = manifest.icons as ManifestIcon[];
    for (const icon of icons) {
      expect(icon.src.startsWith('/icons/')).toBe(true);
    }
  });
});

describe('PWA document wiring (US-36, FR-UI6)', () => {
  const html = readText('index.html');

  it('links the web app manifest', () => {
    expect(html).toMatch(/<link[^>]+rel=["']manifest["'][^>]*>/i);
    expect(html).toContain('manifest.webmanifest');
  });

  it('declares a theme-color matching the manifest', () => {
    expect(html).toMatch(/<meta[^>]+name=["']theme-color["'][^>]*>/i);
    expect(html).toContain('#06090d');
  });

  it('opts into a standalone iOS web app (iOS 16.4+ install path)', () => {
    // The modern key plus Apple's legacy key — iOS only honours the latter for
    // full-screen launch, and US-36 explicitly targets iOS PWA install.
    expect(html).toMatch(/name=["']mobile-web-app-capable["']/i);
    expect(html).toMatch(/name=["']apple-mobile-web-app-capable["']/i);
  });
});
