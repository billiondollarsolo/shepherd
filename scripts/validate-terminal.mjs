/**
 * Visual validation for the elite xterm.js terminal rendering.
 *
 * Drives the in-repo Terminal harness (real <Terminal> = WebGL + unicode11 +
 * web-links + clipboard, fake PTY) and paints a realistic agent-TUI frame:
 *   - DEC Special Graphics box-drawing (ESC(0 — the charset wterm lacked)
 *   - 256-colour + truecolour + bold/dim/italic/underline
 *   - a tmux-style status bar
 *   - unicode (emoji / CJK / powerline) width handling
 * then screenshots it so we can eyeball "local-terminal-grade" fidelity.
 */
const pw = await import(
  '/home/mj/mjcode/flock/node_modules/.pnpm/playwright@1.49.1/node_modules/playwright/index.js'
);
const chromium = pw.chromium ?? pw.default.chromium;
import { writeFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const URL = `${BASE}/src/features/terminal/harness.html`;
const OUT = process.env.OUT ?? '/tmp/flock-terminal.png';

// RENDERER=dom forces the DOM fallback (--disable-webgl trips the addon's
// try/catch). Headless swiftshader WebGL has glyph-atlas spacing artifacts that
// don't occur on real GPUs, so DOM is the reliable CONTENT source-of-truth in CI;
// WebGL (default) proves the GPU path attaches without errors.
const useDom = process.env.RENDERER === 'dom';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || undefined,
  args: useDom
    ? ['--disable-webgl', '--disable-webgl2']
    : ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByTestId('terminal').waitFor({ state: 'visible' });
// Wait for the fake socket to open (connecting indicator gone) + fonts ready.
await page.getByTestId('terminal-status').waitFor({ state: 'detached' }).catch(() => {});
// Ensure the terminal font is actually LOADED (not merely declared) before we
// paint — xterm measures the cell at first paint, so a late font = loose cells.
await page.evaluate(() => document.fonts.load('400 14px "JetBrains Mono"'));
await page.evaluate(() => document.fonts.load('700 14px "JetBrains Mono"'));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);

// Detect which renderer actually attached (WebGL canvas vs DOM rows).
const renderer = await page.evaluate(() => {
  const t = document.querySelector('[data-testid="terminal"]');
  return t?.querySelector('canvas.xterm-link-layer, .xterm-screen canvas')
    ? 'canvas (WebGL/canvas)'
    : 'dom';
});

// Paint a rich frame. \x1b == ESC. ESC(0 enters DEC Special Graphics: in that
// charset lowercase letters map to line-drawing glyphs (q=─ x=│ l=┌ k=┐ m=└ j=┘
// w=┬ v=┴ t=├ u=┤ n=┼). ESC(B returns to ASCII.
const ESC = '\x1b';
const lines = [
  `${ESC}[2J${ESC}[H`,
  `${ESC}[1;38;5;39m  ✻ Welcome to Claude Code${ESC}[0m   ${ESC}[2m(flock cockpit)${ESC}[0m\r\n\r\n`,
  // Box drawn with the DEC charset — the wterm dealbreaker. Must render as lines.
  // Each interior row is built to a fixed 52-visible-column inner width so the
  // right edge lines up (markers like "? "/"✔" are 2 cells; pad accordingly).
  `${ESC}(0lqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqk${ESC}(B\r\n`,
  `${ESC}(0x${ESC}(B ${ESC}[38;5;208m?${ESC}[0m Try "edit <filepath>" to open a file          ${ESC}(0x${ESC}(B\r\n`,
  `${ESC}(0x${ESC}(B ${ESC}[38;5;120m✔${ESC}[0m Bash(npm test) ${ESC}[2m… 271 passed${ESC}[0m                ${ESC}(0x${ESC}(B\r\n`,
  `${ESC}(0tqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu${ESC}(B\r\n`,
  `${ESC}(0x${ESC}(B ${ESC}[3mitalic${ESC}[0m ${ESC}[4munderline${ESC}[0m ${ESC}[1mbold${ESC}[0m ${ESC}[2mdim${ESC}[0m ${ESC}[7mreverse${ESC}[0m           ${ESC}(0x${ESC}(B\r\n`,
  `${ESC}(0mqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqj${ESC}(B\r\n\r\n`,
  // 256-colour ramp + truecolour gradient.
  '  ', ...Array.from({ length: 32 }, (_, i) => `${ESC}[48;5;${16 + i * 6}m  `), `${ESC}[0m\r\n`,
  '  ', ...Array.from({ length: 32 }, (_, i) => `${ESC}[48;2;${i * 8};${128};${255 - i * 8}m  `), `${ESC}[0m\r\n\r\n`,
  // Unicode widths: emoji, CJK, powerline glyphs.
  `  unicode: 🚀 ✨ 🐦 中文 日本語 한국어 ${ESC}[38;5;39m${ESC}[0m powerline\r\n`,
  `  link:    https://claude.ai/code  ${ESC}[2m(clickable)${ESC}[0m\r\n\r\n`,
  // tmux-style green status bar pinned to the bottom region.
  `${ESC}[42;30m flock ${ESC}[0m${ESC}[30;42m 0:claude* ${ESC}[0m${ESC}[2;32m  "node-2" 12:34 29-May-26${ESC}[0m\r\n`,
  `${ESC}[38;5;245m❯${ESC}[0m `,
];
await page.evaluate((chunk) => window.__ptyEmit(chunk), lines.join(''));
await page.waitForTimeout(400);
// Scroll the emulator viewport to the top so the box-drawing frame (top of the
// frame) is captured, not just the prompt tail.
await page.evaluate(() => {
  const vp = document.querySelector('.xterm-viewport');
  if (vp) vp.scrollTop = 0;
});
await page.waitForTimeout(150);

const buf = await page.getByTestId('terminal').screenshot();
writeFileSync(OUT, buf);

console.log(JSON.stringify({ renderer, out: OUT, consoleErrors: errors.slice(0, 10) }, null, 2));
await browser.close();
