import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const roots = ['packages/shared/src', 'apps/orchestrator/src', 'apps/web/src'].map((value) =>
  path.join(root, value),
);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return sourceExtensions.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

const files = roots.flatMap(walk);
const known = new Set(files.map((file) => path.normalize(file)));
const graph = new Map(files.map((file) => [file, []]));
const failures = [];
const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

function area(file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  if (relative.startsWith('packages/shared/')) return 'shared';
  if (relative.startsWith('apps/orchestrator/')) return 'orchestrator';
  if (relative.startsWith('apps/web/')) return 'web';
  return 'other';
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const target = resolveRelative(file, specifier);
    if (!target || !known.has(target)) continue;
    graph.get(file).push(target);
    const fromArea = area(file);
    const targetArea = area(target);
    if (fromArea !== targetArea && targetArea !== 'other') {
      failures.push(
        `Forbidden source-boundary import: ${path.relative(root, file)} -> ${path.relative(root, target)}`,
      );
    }
  }
}

const state = new Map();
const stack = [];
function visit(file) {
  state.set(file, 1);
  stack.push(file);
  for (const target of graph.get(file) ?? []) {
    if (state.get(target) === 1) {
      const start = stack.indexOf(target);
      const cycle = [...stack.slice(start), target]
        .map((entry) => path.relative(root, entry))
        .join(' -> ');
      failures.push(`Circular import: ${cycle}`);
    } else if (!state.has(target)) {
      visit(target);
    }
  }
  stack.pop();
  state.set(file, 2);
}
for (const file of files) if (!state.has(file)) visit(file);

const orchestratorManifest = JSON.parse(
  readFileSync(path.join(root, 'apps/orchestrator/package.json'), 'utf8'),
);
if (orchestratorManifest.dependencies?.['node-pty']) {
  failures.push('The orchestrator must not depend on node-pty; local PTYs belong to node-runtime.');
}
if (existsSync(path.join(root, 'apps/orchestrator/src/nodes/transport/local-transport.ts'))) {
  failures.push('Legacy LocalTransport returned; local node operations must cross agentd.');
}
const orchestratorDockerfile = readFileSync(
  path.join(root, 'docker/Dockerfile.orchestrator'),
  'utf8',
);
for (const forbidden of [
  'npm install -g @openai/codex',
  'opencode.ai/install',
  'flock-agentd /usr/local/bin',
]) {
  if (orchestratorDockerfile.includes(forbidden)) {
    failures.push(`Orchestrator image regained local-runtime responsibility: ${forbidden}`);
  }
}
const composeSource = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const orchestratorBlock = composeSource.split(/^  orchestrator:/m)[1]?.split(/^  [a-z]/m)[0] ?? '';
for (const forbidden of ['flock_agent_home', 'flock_agentd_state']) {
  if (orchestratorBlock.includes(forbidden)) {
    failures.push(`Orchestrator Compose service must not mount ${forbidden}.`);
  }
}

if (failures.length > 0) {
  console.error([...new Set(failures)].join('\n'));
  process.exit(1);
}
console.log(
  `Architecture check passed (${files.length} source files, no cycles or boundary violations).`,
);
