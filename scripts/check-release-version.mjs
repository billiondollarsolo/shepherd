import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  resolve(root, 'scripts/generate-agentd-compatibility.mjs'),
  '--check',
]);
const canonical = readFileSync(resolve(root, 'agentd/VERSION'), 'utf8').trim();
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

if (!semver.test(canonical)) {
  throw new Error(`agentd/VERSION is not valid SemVer: ${canonical}`);
}

const compatibility = JSON.parse(readFileSync(resolve(root, 'agentd/COMPATIBILITY.json'), 'utf8'));
const agentdGoMod = readFileSync(resolve(root, 'agentd/go.mod'), 'utf8');
if (!agentdGoMod.startsWith('module github.com/billiondollarsolo/flock/agentd\n')) {
  throw new Error('agentd/go.mod does not expose the published nested module path');
}
const protocols = compatibility.supportedProtocolVersions;
const capabilities = compatibility.requiredCapabilities;
if (compatibility.schemaVersion !== 1) {
  throw new Error('agentd/COMPATIBILITY.json has an unsupported schemaVersion');
}
if (!semver.test(compatibility.minimumDaemonVersion ?? '')) {
  throw new Error('agentd compatibility minimumDaemonVersion is not valid SemVer');
}
const coreVersion = (value) => value.split(/[+-]/, 1)[0].split('.').map(Number);
const compareCore = (left, right) => {
  const a = coreVersion(left);
  const b = coreVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};
if (compareCore(compatibility.minimumDaemonVersion, canonical) > 0) {
  throw new Error('agentd compatibility minimum exceeds the release daemon version');
}
if (
  !Array.isArray(protocols) ||
  protocols.length === 0 ||
  protocols.some((version) => !Number.isInteger(version) || version <= 0) ||
  new Set(protocols).size !== protocols.length ||
  !protocols.includes(compatibility.preferredProtocolVersion)
) {
  throw new Error('agentd compatibility protocol metadata is invalid');
}
if (
  !Array.isArray(capabilities) ||
  capabilities.length === 0 ||
  capabilities.some((capability) => typeof capability !== 'string' || !capability) ||
  new Set(capabilities).size !== capabilities.length
) {
  throw new Error('agentd compatibility capability metadata is invalid');
}
if (
  !Number.isInteger(compatibility.supportWindow?.minorReleases) ||
  compatibility.supportWindow.minorReleases < 1 ||
  !Number.isInteger(compatibility.supportWindow?.minimumDays) ||
  compatibility.supportWindow.minimumDays < 1
) {
  throw new Error('agentd compatibility support window is invalid');
}
const goProtocol = readFileSync(resolve(root, 'agentd/proto/proto.go'), 'utf8');
const tsProtocol = readFileSync(
  resolve(root, 'apps/orchestrator/src/nodes/agentd/protocol.ts'),
  'utf8',
);
const goPreferred = Number(goProtocol.match(/const ProtocolVersion = (\d+)/)?.[1]);
const tsPreferred = Number(tsProtocol.match(/AGENTD_PROTOCOL_VERSION = (\d+)/)?.[1]);
const retainedClientProtocols = Array.from(
  tsProtocol.match(/AGENTD_CLIENT_PROTOCOL_VERSIONS = \[([^\]]+)\]/)?.[1]?.matchAll(/\d+/g) ?? [],
  (match) => Number(match[0]),
);
if (
  goPreferred !== compatibility.preferredProtocolVersion ||
  tsPreferred !== compatibility.preferredProtocolVersion
) {
  throw new Error('agentd preferred protocol is not synchronized across the release');
}
if (
  retainedClientProtocols.length !== protocols.length ||
  protocols.some((version) => !retainedClientProtocols.includes(version))
) {
  throw new Error('agentd compatibility lists a protocol without a retained client codec');
}
const serverSource = readFileSync(resolve(root, 'agentd/internal/server/server.go'), 'utf8');
for (const capability of capabilities) {
  if (!serverSource.includes(`"${capability}"`)) {
    throw new Error(`agentd does not advertise required capability ${capability}`);
  }
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
  throw new Error(`docker-compose.yml does not default to Shepherd ${canonical}`);
}
for (const image of ['orchestrator', 'web']) {
  if (!compose.includes(`shepherd-${image}:\${FLOCK_VERSION:-${canonical}}`)) {
    throw new Error(`docker-compose.yml does not couple shepherd-${image} to ${canonical}`);
  }
}
if (!compose.includes('traefik:v3.7@sha256:')) {
  throw new Error('docker-compose.yml does not pin the official Traefik v3.7 manifest');
}
if (!compose.includes('postgres:16-bookworm@sha256:')) {
  throw new Error('docker-compose.yml does not pin the official PostgreSQL 16 manifest');
}
if (compose.includes('shepherd-caddy:') || compose.includes('shepherd-postgres:')) {
  throw new Error('docker-compose.yml still references retired Shepherd wrapper images');
}
if (!compose.includes(`shepherd-node-runtime:\${FLOCK_NODE_RUNTIME_VERSION:-${canonical}}`)) {
  throw new Error(`docker-compose.yml does not pin shepherd-node-runtime independently`);
}

const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
if (!envExample.includes(`FLOCK_VERSION=${canonical}`)) {
  throw new Error(`.env.example does not pin FLOCK_VERSION=${canonical}`);
}
if (!envExample.includes(`FLOCK_NODE_RUNTIME_VERSION=${canonical}`)) {
  throw new Error(`.env.example does not pin FLOCK_NODE_RUNTIME_VERSION=${canonical}`);
}

const deploymentManifest = JSON.parse(
  readFileSync(resolve(root, 'deploy/release-manifest.json'), 'utf8'),
);
if (
  deploymentManifest.schemaVersion !== 1 ||
  deploymentManifest.topologyGeneration !== 2 ||
  deploymentManifest.controlPlaneVersion !== canonical ||
  deploymentManifest.runtime?.preferredVersion !== canonical ||
  !deploymentManifest.runtime?.requiredCapabilities?.includes('exec_v1') ||
  !deploymentManifest.runtime?.requiredCapabilities?.includes('tcp_tunnel_v1')
) {
  throw new Error('deploy/release-manifest.json is not synchronized with the runtime topology');
}

const upstreamImages = deploymentManifest.upstreamImages ?? {};
for (const [name, image] of Object.entries(upstreamImages)) {
  if (typeof image !== 'string' || !image.includes('@sha256:')) {
    throw new Error(`deploy/release-manifest.json does not pin upstream ${name} by digest`);
  }
}
for (const [file, imageNames] of [
  ['docker-compose.yml', ['traefik', 'postgres']],
  ['docker-compose.local.yml', ['traefik', 'postgres']],
  ['docker-compose.dev.yml', ['postgres']],
  ['docker/Dockerfile.dev', ['postgres']],
  ['docker/Dockerfile.orchestrator', ['postgres']],
  ['.env.example', ['traefik', 'postgres']],
]) {
  const contents = readFileSync(resolve(root, file), 'utf8');
  for (const imageName of imageNames) {
    const image = upstreamImages[imageName];
    if (!contents.includes(image)) {
      throw new Error(`${file} is not synchronized with the pinned upstream ${imageName} image`);
    }
  }
}

const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release-images.yml'), 'utf8');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
for (const [name, workflow] of [
  ['CI', ciWorkflow],
  ['release', releaseWorkflow],
]) {
  if (!workflow.includes('osv-scanner@v2.4.0')) {
    throw new Error(`${name} workflow does not use the pinned OSV dependency scanner`);
  }
  if (workflow.includes('pnpm audit')) {
    throw new Error(`${name} workflow still calls the retired pnpm audit endpoint`);
  }
}
if (releaseWorkflow.includes('shepherd-session-chrome')) {
  throw new Error('release workflow still publishes the retired session-Chrome image');
}
if (releaseWorkflow.includes('/api/sessions/$session_id/preview')) {
  throw new Error('release workflow still calls the retired session-owned Preview API');
}
if (
  releaseWorkflow.includes('aquasec/trivy:0.66.0 image') ||
  !releaseWorkflow.includes('aquasec/trivy:0.66.0@sha256:')
) {
  throw new Error('release workflow does not pin the Trivy scanner image by digest');
}
if (!releaseWorkflow.includes('/api/projects/$project_id/ports/$service_id/forward')) {
  throw new Error('release workflow does not smoke the project-owned Ports API');
}
for (const required of [
  'docker/Dockerfile.node-runtime',
  'shepherd-node-runtime',
  'FLOCK_VERSION: candidate-${{ github.sha }}',
  'FLOCK_NODE_RUNTIME_VERSION: candidate-${{ github.sha }}',
  'IMAGE_VERSION=${{ github.ref_name }}',
  'osv-scanner@v2.4.0',
  'test-node-runtime-migration.sh',
  'test-deployment-bundle.sh',
  'survived orchestrator recreation',
  'build-deployment-bundle.sh',
]) {
  if (!releaseWorkflow.includes(required)) {
    throw new Error(`release workflow is missing runtime evidence: ${required}`);
  }
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${canonical}]`)) {
  throw new Error(`CHANGELOG.md has no ${canonical} release section`);
}

const expected = process.env.EXPECTED_VERSION?.replace(/^v/, '');
if (expected && expected !== canonical) {
  throw new Error(`release/tag version ${expected} does not match repository ${canonical}`);
}

console.log(
  `Shepherd version ${canonical} is synchronized; agentd >=${compatibility.minimumDaemonVersion}, protocol ${protocols.join('/')}.`,
);
