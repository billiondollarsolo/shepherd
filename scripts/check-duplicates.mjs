import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoots = ['packages/shared/src', 'apps/orchestrator/src', 'apps/web/src'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const minimumLines = 12;
const maximumDuplicatePercent = 3;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    if (!extensions.has(path.extname(entry.name))) return [];
    if (/\.(?:test|spec|int\.test)\.[^.]+$/.test(entry.name)) return [];
    return [absolute];
  });
}

function normalize(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const files = sourceRoots.flatMap((directory) => walk(path.join(root, directory)));
const windows = new Map();
const normalizedFiles = new Map();
let meaningfulLines = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map(normalize);
  normalizedFiles.set(file, lines);
  meaningfulLines += lines.filter(Boolean).length;
  for (let start = 0; start <= lines.length - minimumLines; start += 1) {
    const block = lines.slice(start, start + minimumLines);
    if (block.some((line) => !line)) continue;
    const key = block.join('\n');
    const locations = windows.get(key) ?? [];
    locations.push({ file, start });
    windows.set(key, locations);
  }
}

const duplicateLines = new Map();
const reportedPairs = new Set();
const examples = [];
for (const locations of windows.values()) {
  if (locations.length < 2) continue;
  const first = locations[0];
  for (const current of locations.slice(1)) {
    if (current.file === first.file && Math.abs(current.start - first.start) < minimumLines)
      continue;
    for (const location of [first, current]) {
      const lines = duplicateLines.get(location.file) ?? new Set();
      for (let line = location.start; line < location.start + minimumLines; line += 1)
        lines.add(line);
      duplicateLines.set(location.file, lines);
    }
    const pair = [
      `${path.relative(root, first.file)}:${first.start + 1}`,
      `${path.relative(root, current.file)}:${current.start + 1}`,
    ].sort();
    const key = pair.join(' <> ');
    if (!reportedPairs.has(key) && examples.length < 10) examples.push(key);
    reportedPairs.add(key);
  }
}

const duplicated = [...duplicateLines.values()].reduce((sum, lines) => sum + lines.size, 0);
const duplicatePercent = meaningfulLines === 0 ? 0 : (duplicated / meaningfulLines) * 100;
if (duplicatePercent > maximumDuplicatePercent) {
  console.error(
    `Duplicate-code budget exceeded: ${duplicatePercent.toFixed(2)}% > ${maximumDuplicatePercent.toFixed(2)}%.`,
  );
  if (examples.length > 0) console.error(`Representative blocks:\n${examples.join('\n')}`);
  process.exit(1);
}

console.log(
  `Duplicate-code check passed (${duplicatePercent.toFixed(2)}% duplicated lines, budget ${maximumDuplicatePercent.toFixed(2)}%, ${files.length} files).`,
);
