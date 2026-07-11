import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .trim()
  .split('\n')
  .filter(Boolean);
const failures = [];

function slug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

for (const file of files) {
  const absolute = resolve(root, file);
  const source = readFileSync(absolute, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
    const [pathPart, anchor] = raw.split('#', 2);
    const target = resolve(dirname(absolute), decodeURIComponent(pathPart));
    if (!existsSync(target)) {
      failures.push(`${file}: broken local link ${raw}`);
      continue;
    }
    if (anchor && extname(target).toLowerCase() === '.md') {
      const targetSource = readFileSync(target, 'utf8');
      const anchors = new Set(
        [...targetSource.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1])),
      );
      if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
        failures.push(`${file}: missing anchor ${raw}`);
      }
    }
  }
}

const authoritative = [
  'README.md',
  'docs/README.md',
  'docs/architecture.md',
  'docs/deployment.md',
  'docs/releasing.md',
  'docs/backup-and-recovery.md',
  'docs/operations-and-diagnostics.md',
];
for (const file of authoritative) {
  const source = readFileSync(resolve(root, file), 'utf8');
  if (/\b(?:Mission Control|Fleet Scope)\b/i.test(source)) {
    failures.push(`${file}: obsolete product terminology`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `Documentation check passed (${files.length} Markdown files; local links and terminology).`,
);
