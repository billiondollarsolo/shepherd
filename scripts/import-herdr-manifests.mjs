#!/usr/bin/env node
/**
 * Stub: periodic Herdr → Shepherd screendetect manifest import (D13).
 *
 * Workflow (human-reviewed; never a live runtime dependency on Herdr):
 *   1. Ensure a sibling Herdr checkout exists at ../herdr (relative to shepherd/).
 *   2. Upstream source: ../herdr/src/detect/manifests/*.toml
 *   3. Shepherd target: agentd/internal/screendetect/manifests/*.toml
 *   4. Copy or diff upstream into Shepherd-adapted files; review false positives,
 *      headers (Apache-2.0 attribution → docs/herdr-attribution.md), and engine
 *      compatibility (min_engine_version).
 *   5. Land only as reviewed patches — do not auto-overwrite product-tuned rules.
 *
 * This script documents the workflow and lists available upstream TOML when the
 * sibling tree is present. It does not apply patches automatically.
 *
 * Usage:
 *   node scripts/import-herdr-manifests.mjs
 *   node scripts/import-herdr-manifests.mjs --help
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shepherdRoot = resolve(__dirname, '..');
const upstreamDir = resolve(shepherdRoot, '../herdr/src/detect/manifests');
const targetDir = resolve(shepherdRoot, 'agentd/internal/screendetect/manifests');

const HELP = `
import-herdr-manifests — document / list Herdr manifest import (D13)

Shepherd-owned adapted manifests live at:
  ${targetDir}

Upstream Herdr manifests (sibling checkout):
  ${upstreamDir}

Workflow:
  1. Checkout or update sibling ../herdr
  2. Diff upstream *.toml against Shepherd adapted copies
  3. Port rule content carefully; keep Apache-2.0 header + docs/herdr-attribution.md
  4. Do not introduce a runtime dependency on Herdr
  5. Human review before merge

Options:
  -h, --help    Show this help and exit 0

Status: stub — lists upstream files when present; does not copy or patch.
`.trim();

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }

  console.log('Herdr → Shepherd screendetect manifest import (stub, D13)\n');
  console.log(`Shepherd target: ${targetDir}`);
  console.log(`Upstream expect: ${upstreamDir}\n`);

  if (existsSync(targetDir)) {
    const local = readdirSync(targetDir).filter((f) => f.endsWith('.toml')).sort();
    console.log(`Shepherd adapted manifests (${local.length}):`);
    for (const f of local) console.log(`  - ${f}`);
    console.log();
  } else {
    console.log('Shepherd target directory missing (create when porting manifests).\n');
  }

  if (existsSync(upstreamDir)) {
    const upstream = readdirSync(upstreamDir).filter((f) => f.endsWith('.toml')).sort();
    console.log(`Upstream Herdr manifests available (${upstream.length}):`);
    for (const f of upstream) console.log(`  - ${f}`);
    console.log('\nNext: manually diff/copy selected files into the Shepherd target,');
    console.log('review, and commit. See docs/herdr-attribution.md.');
  } else {
    console.log('Sibling Herdr manifests not found (optional).');
    console.log('Clone or place Herdr next to shepherd so the path exists:');
    console.log(`  ${upstreamDir}`);
    console.log('\nSee docs/herdr-attribution.md for license and maintenance policy.');
  }

  process.exit(0);
}

main(process.argv.slice(2));
