#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const allowlist = JSON.parse(
  readFileSync(resolve(root, 'scripts/brand-surface-allowlist.json'), 'utf8'),
);
const allowedPaths = allowlist.pathPatterns.map(({ pattern, reason }) => ({
  pattern: new RegExp(pattern),
  reason,
}));
const allowedLines = allowlist.linePatterns.map(({ pattern, reason }) => ({
  pattern: new RegExp(pattern),
  reason,
}));
const failures = [];

function source(file) {
  return readFileSync(resolve(root, file), 'utf8');
}

function requireText(file, expected) {
  const contents = source(file);
  for (const value of expected) {
    if (!contents.includes(value)) failures.push(`${file}: missing ${JSON.stringify(value)}`);
  }
}

const expected = {
  'apps/web/src/brand.ts': [
    "PRODUCT_NAME = 'Shepherd'",
    "PRODUCT_TAGLINE = 'Shepherd Your Agents'",
    'Supervise CLI coding agents across local and remote nodes from one web paddock.',
    "PRODUCT_REPOSITORY_URL = 'https://github.com/billiondollarsolo/flock'",
  ],
  'apps/web/index.html': [
    '<title>Shepherd</title>',
    'name="description"',
    'content="Supervise CLI coding agents across local and remote nodes from one web paddock."',
    'name="apple-mobile-web-app-title" content="Shepherd"',
  ],
  'apps/web/public/manifest.webmanifest': [
    '"name": "Shepherd — Agent Paddock"',
    '"short_name": "Shepherd"',
  ],
  'apps/web/public/sw.js': ["title: 'Shepherd'", "data.title || 'Shepherd'"],
  'apps/web/public/icons/icon.svg': ['aria-label="Shepherd"'],
  'apps/web/public/icons/icon-maskable.svg': ['aria-label="Shepherd"'],
  'README.md': ['# Shepherd', '### Shepherd Your Agents', '## What is Shepherd?'],
  'docs/README.md': ['# Shepherd documentation'],
  '.github/ISSUE_TEMPLATE/bug_report.yml': ['Shepherd version'],
  '.github/ISSUE_TEMPLATE/feature_request.yml': [
    'What user problem or workflow gap should Shepherd solve?',
  ],
  '.github/workflows/release-images.yml': ['--title "Shepherd ${TAG#v}"'],
};

for (const [file, fragments] of Object.entries(expected)) requireText(file, fragments);

const packageNames = {
  'package.json': 'flock',
  'apps/web/package.json': '@flock/web',
  'apps/orchestrator/package.json': '@flock/orchestrator',
  'packages/shared/package.json': '@flock/shared',
};
for (const [file, expectedName] of Object.entries(packageNames)) {
  const actual = JSON.parse(source(file)).name;
  if (actual !== expectedName) failures.push(`${file}: package name changed to ${actual}`);
}

const retainedContracts = {
  'agentd/go.mod': ['module github.com/billiondollarsolo/flock/agentd'],
  'docker-compose.yml': ['flock-orchestrator:', 'flock-web:', 'flock-session-chrome:'],
  'apps/web/src/theme/themeContext.ts': ["THEME_STORAGE_KEY = 'flock.theme'"],
  'apps/web/public/sw.js': [
    "const SHELL_CACHE = 'flock-shell-v2'",
    '`flock-session-${data.sessionId}`',
  ],
  'packages/shared/src/backup.ts': ['flockVersion:'],
  'packages/shared/src/diagnostics.ts': ['flock:'],
  'agentd/internal/session/flock-mcp.mjs': ["serverInfo: { name: 'flock'"],
};
for (const [file, fragments] of Object.entries(retainedContracts)) requireText(file, fragments);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

for (const file of files) {
  if (allowedPaths.some(({ pattern }) => pattern.test(file))) continue;
  let contents;
  try {
    contents = source(file);
  } catch {
    continue;
  }
  if (contents.includes('\0')) continue;
  contents.split(/\r?\n/).forEach((line, index) => {
    if (!/\bFlock\b/.test(line)) return;
    if (allowedLines.some(({ pattern }) => pattern.test(line))) return;
    failures.push(`${file}:${index + 1}: unapproved former product name: ${line.trim()}`);
  });

  if (
    file !== 'scripts/check-brand-surface.mjs' &&
    /^(?:apps|agentd|packages|docker|scripts)(?:\/|$)|^docker-compose/.test(file)
  ) {
    const forbiddenTechnicalRenames = [
      /\bSHEPHERD_[A-Z0-9_]+\b/,
      /@shepherd\//,
      /github\.com\/billiondollarsolo\/shepherd/,
      /(?:^|[/'"`])shepherd-agentd\b/,
      /--shepherd-/,
      /['"`]shepherd\.(?:theme|sidebar|grid|assistive|rightPanel)/,
    ];
    for (const pattern of forbiddenTechnicalRenames) {
      if (pattern.test(contents)) failures.push(`${file}: premature technical rename ${pattern}`);
    }
  }
}

if (process.argv.includes('--dist')) {
  const dist = 'apps/web/dist';
  if (!existsSync(resolve(root, dist))) {
    failures.push(`${dist}: missing production build (run pnpm build first)`);
  } else {
    requireText(`${dist}/index.html`, [
      '<title>Shepherd</title>',
      'Supervise CLI coding agents across local and remote nodes from one web paddock.',
    ]);
    requireText(`${dist}/manifest.webmanifest`, [
      '"name": "Shepherd — Agent Paddock"',
      '"short_name": "Shepherd"',
    ]);
    requireText(`${dist}/sw.js`, ["data.title || 'Shepherd'"]);
    requireText(`${dist}/icons/icon.svg`, ['aria-label="Shepherd"']);
    requireText(`${dist}/icons/icon-maskable.svg`, ['aria-label="Shepherd"']);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `Brand surface check passed (${files.length} files; Shepherd surfaces and retained-identifier policy).`,
);
