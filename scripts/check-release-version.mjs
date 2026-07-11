import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const canonical = readFileSync(resolve(root, 'agentd/VERSION'), 'utf8').trim();
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

if (!semver.test(canonical)) {
  throw new Error(`agentd/VERSION is not valid SemVer: ${canonical}`);
}

const manifests = [
  'package.json',
  'apps/orchestrator/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];

for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  if (manifest.version !== canonical) {
    throw new Error(`${file} has version ${manifest.version}; expected ${canonical}`);
  }
}

const orchestratorManifest = JSON.parse(
  readFileSync(resolve(root, 'apps/orchestrator/package.json'), 'utf8'),
);
if (orchestratorManifest.scripts?.migrate !== 'node dist/db/migrate.js') {
  throw new Error('orchestrator production migrate script is missing or unsafe');
}

const mcp = readFileSync(resolve(root, 'agentd/internal/session/flock-mcp.mjs'), 'utf8');
if (!mcp.includes(`serverInfo: { name: 'flock', version: '${canonical}' }`)) {
  throw new Error(`flock-mcp.mjs does not report version ${canonical}`);
}

const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
if (!compose.includes(`FLOCK_VERSION:-${canonical}`)) {
  throw new Error(`docker-compose.yml does not default to Flock ${canonical}`);
}
if (!compose.includes(`flock-session-chrome:${canonical}`)) {
  throw new Error(`docker-compose.yml does not default session Chrome to ${canonical}`);
}

const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
if (!envExample.includes(`FLOCK_VERSION=${canonical}`)) {
  throw new Error(`.env.example does not pin FLOCK_VERSION=${canonical}`);
}
if (!envExample.includes(`flock-session-chrome:${canonical}`)) {
  throw new Error(`.env.example does not pin session Chrome to ${canonical}`);
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${canonical}]`)) {
  throw new Error(`CHANGELOG.md has no ${canonical} release section`);
}

const expected = process.env.EXPECTED_VERSION?.replace(/^v/, '');
if (expected && expected !== canonical) {
  throw new Error(`release/tag version ${expected} does not match repository ${canonical}`);
}

console.log(`Flock version ${canonical} is synchronized.`);
