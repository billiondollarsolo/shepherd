#!/usr/bin/env node
/**
 * generate-pwa-icons.mjs — rasterize the brand SVGs into the PNG assets the PWA
 * manifest + iOS home-screen icon reference.
 *
 * WHY THIS IS A SCRIPT, NOT COMMITTED BINARIES: no image rasterizer
 * (sharp / imagemagick / rsvg) ships in this repo's install, so the PNGs can't
 * be produced at build time here. The manifest (`public/manifest.webmanifest`)
 * and `index.html` already REFERENCE the PNG paths this script emits — only the
 * binaries are missing. Run this once a rasterizer is available:
 *
 *     pnpm add -D sharp
 *     node scripts/generate-pwa-icons.mjs
 *
 * Outputs (into public/icons/, next to the source SVGs):
 *   icon-192.png            192×192   from icon.svg          (purpose: any)
 *   icon-512.png            512×512   from icon.svg          (purpose: any)
 *   icon-maskable-192.png   192×192   from icon-maskable.svg (purpose: maskable)
 *   icon-maskable-512.png   512×512   from icon-maskable.svg (purpose: maskable)
 *   apple-touch-icon.png    180×180   from icon.svg          (iOS home screen)
 *
 * The SVGs stay in the manifest as the `sizes:"any"` progressive entries, so
 * capable browsers keep the crisp vector while iOS/Lighthouse get real PNGs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, '..', 'public', 'icons');

/** [source SVG, output PNG, edge size in px]. */
const TARGETS = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-192.png', 192],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
];

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function main() {
  const sharp = await loadSharp();
  if (!sharp) {
    console.error(
      '[generate-pwa-icons] `sharp` is not installed, so no rasterizer is available.\n' +
        'Install it, then re-run:\n\n' +
        '    pnpm add -D sharp\n' +
        '    node scripts/generate-pwa-icons.mjs\n',
    );
    process.exitCode = 1;
    return;
  }

  for (const [srcName, outName, size] of TARGETS) {
    const srcPath = resolve(iconsDir, srcName);
    const outPath = resolve(iconsDir, outName);
    const svg = await readFile(srcPath);
    const png = await sharp(svg, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    await writeFile(outPath, png);
    console.log(`[generate-pwa-icons] wrote ${outName} (${size}×${size}) from ${srcName}`);
  }
  console.log('[generate-pwa-icons] done.');
}

main().catch((err) => {
  console.error('[generate-pwa-icons] failed:', err);
  process.exitCode = 1;
});
