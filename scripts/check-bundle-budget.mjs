#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/web/dist');
const manifestPath = join(dist, '.vite/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const KiB = 1024;

function entry(label, predicate) {
  const matches = Object.entries(manifest).filter(([key, value]) => predicate(key, value));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one manifest entry, found ${matches.length}`);
  }
  const [key, value] = matches[0];
  return { label, key, value };
}

function measurement(file) {
  const bytes = readFileSync(join(dist, file));
  return {
    file,
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes).length,
  };
}

function assertBudget(label, actual, limits) {
  const failures = Object.entries(limits)
    .filter(([kind, limit]) => actual[kind] > limit * KiB)
    .map(([kind, limit]) => `${kind} ${(actual[kind] / KiB).toFixed(1)} KiB exceeds ${limit} KiB`);
  if (failures.length) throw new Error(`${label}: ${failures.join('; ')}`);
}

// Prove the comparison fails closed rather than accidentally accepting an
// oversized fixture. This is deliberately run on every invocation.
try {
  assertBudget('budget self-test', { raw: 2 * KiB }, { raw: 1 });
  throw new Error('bundle budget self-test failed to reject an oversized fixture');
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('exceeds')) throw error;
}

const shell = entry('application shell', (_key, value) => value.isEntry === true);
const shellCssFile = shell.value.css?.[0];
if (!shellCssFile) throw new Error('application shell: missing entry stylesheet');

const targets = [
  [shell, { raw: 650, gzip: 200, brotli: 170 }],
  [
    entry('desktop paddock', (_key, value) => value.name === 'Paddock'),
    { raw: 125, gzip: 34, brotli: 29 },
  ],
  [
    entry('mobile paddock', (_key, value) => value.name === 'PhonePaddock'),
    { raw: 25, gzip: 8, brotli: 7 },
  ],
  [
    // Bumped in 0.6.1: the new-session dialog gained the Terminal/Chat launch mode
    // toggle on top of the existing agent/model/effort/permission controls.
    entry('shared dialogs', (_key, value) => value.name === 'PaddockDialogs'),
    { raw: 48, gzip: 15, brotli: 14 },
  ],
  [
    entry('desktop terminal', (_key, value) => value.name === 'Terminal'),
    { raw: 350, gzip: 95, brotli: 80 },
  ],
  [
    entry('mobile Ghostty engine', (key) => key.endsWith('/ghostty-web.js')),
    { raw: 670, gzip: 200, brotli: 165 },
  ],
  [
    entry('code editor', (_key, value) => value.name === 'CodeEditor'),
    { raw: 810, gzip: 295, brotli: 240 },
  ],
  [
    entry('terminal font CSS', (key) => key.endsWith('/terminal-font-assets.css')),
    { raw: 26, gzip: 17, brotli: 16 },
  ],
];

const results = new Map();
for (const [target, limits] of targets) {
  const measured = measurement(target.value.file);
  assertBudget(target.label, measured, limits);
  results.set(target.label, measured);
}

const shellCss = measurement(shellCssFile);
// Bumped in 0.6.1: the t3code-style restyle (new utilities, rounder radii) + the
// highlight.js token theme for chat code blocks grew the shared stylesheet.
assertBudget('application shell CSS', shellCss, { raw: 72, gzip: 16, brotli: 14 });
results.set('application shell CSS', shellCss);

const nerdFont = shell.value.assets
  ? Object.values(manifest)
      .flatMap((value) => value.assets ?? [])
      .find((file) => file.includes('JetBrainsMonoNerdFontMono-Regular'))
  : undefined;
// Vite may associate an on-demand URL asset with no importing entry. Resolve it
// from the terminal-font stylesheet's emitted assets when that happens.
const nerdAsset =
  nerdFont ??
  Object.values(manifest)
    .flatMap((value) => value.assets ?? [])
    .find((file) => file.includes('JetBrainsMonoNerdFontMono-Regular'));
if (!nerdAsset) {
  // Manifest asset ownership can vary across Vite patch versions; the filename
  // remains content-addressed and is the stable release invariant.
  const terminalCss = readFileSync(join(dist, targets[7][0].value.file), 'utf8');
  const match = terminalCss.match(/\/assets\/(JetBrainsMonoNerdFontMono-Regular-[^)"']+\.woff2)/);
  if (!match) throw new Error('terminal Nerd Font asset is missing');
  const nerd = measurement(`assets/${match[1]}`);
  assertBudget('terminal Nerd Font', nerd, { raw: 1075 });
  results.set('terminal Nerd Font', nerd);
} else {
  const nerd = measurement(nerdAsset);
  assertBudget('terminal Nerd Font', nerd, { raw: 1075 });
  results.set('terminal Nerd Font', nerd);
}

const initialAssets = [shell.value.file, shellCssFile, ...(shell.value.assets ?? [])].join('\n');
if (/terminal-font|JetBrainsMonoNerd|noto-sans-symbols|jetbrains-mono-/i.test(initialAssets)) {
  throw new Error('terminal-only fonts leaked into the initial application shell');
}

function routeTotal(labels) {
  return labels.reduce(
    (total, label) => ({
      raw: total.raw + results.get(label).raw,
      gzip: total.gzip + results.get(label).gzip,
      brotli: total.brotli + results.get(label).brotli,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );
}

const desktopInitial = routeTotal([
  'application shell',
  'application shell CSS',
  'desktop paddock',
  'shared dialogs',
]);
const mobileInitial = routeTotal([
  'application shell',
  'application shell CSS',
  'mobile paddock',
  'shared dialogs',
]);
assertBudget('desktop initial route', desktopInitial, { gzip: 260, brotli: 220 });
assertBudget('mobile initial route', mobileInitial, { gzip: 240, brotli: 205 });

const rows = [
  ...results.entries(),
  ['desktop initial route', desktopInitial],
  ['mobile initial route', mobileInitial],
];
console.log('Bundle budgets passed');
for (const [label, value] of rows) {
  console.log(
    `${label.padEnd(24)} raw ${(value.raw / KiB).toFixed(1).padStart(7)} KiB  gzip ${(value.gzip / KiB).toFixed(1).padStart(6)} KiB  br ${(value.brotli / KiB).toFixed(1).padStart(6)} KiB`,
  );
}
