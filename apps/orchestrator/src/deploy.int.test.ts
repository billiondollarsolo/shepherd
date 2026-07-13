/**
 * US-38 — Production Docker Compose deploy (TDD acceptance test).
 *
 * Verifies the production `docker-compose.yml` and the prod Dockerfiles satisfy
 * the US-38 acceptance criteria and the mapped NFRs:
 *
 *   - `docker compose up` brings up orchestrator + Postgres                (US-38)
 *   - per-session browsers are managed by a constrained worker that alone
 *     receives the Docker socket                                             (NFR-DEP1)
 *   - secrets via env / secret files, not baked into images                 (NFR-DEP2)
 *
 * These are structural assertions over the deploy artifacts (no live Docker
 * daemon required) plus an optional `docker compose config` smoke when the
 * Docker CLI is available. Runs under `test:int`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
// apps/orchestrator/src -> repo root
const repoRoot = resolve(here, '..', '..', '..');

const composePath = resolve(repoRoot, 'docker-compose.yml');
const orchDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.orchestrator');
const orchEntrypoint = resolve(repoRoot, 'docker', 'orchestrator-entrypoint.sh');
const browserWorkerEntrypoint = resolve(repoRoot, 'docker', 'browser-worker-entrypoint.sh');
const secretStager = resolve(repoRoot, 'docker', 'stage-secret.sh');
const webDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.web');
const envExample = resolve(repoRoot, '.env.example');
const caddyfile = resolve(repoRoot, 'docker', 'Caddyfile');
const nodePrepare = resolve(repoRoot, 'scripts', 'flock-node-prepare.sh');
const upgradeScript = resolve(repoRoot, 'scripts', 'flock-upgrade.sh');
const vagrantProvision = resolve(repoRoot, 'vagrant', 'provision.sh');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Returns the body of a top-level YAML mapping key (e.g. `services`), i.e. the
 * lines from after `key:` up to (but not including) the next top-level key
 * (a line that starts at column 0 with a non-space, non-comment character).
 */
function extractTopLevelBlock(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (startIdx === -1) return '';
  const body: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // A new top-level key terminates the block.
    if (/^[^\s#].*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function extractServiceBlock(yaml: string, service: string): string {
  const services = extractTopLevelBlock(yaml, 'services').split('\n');
  const start = services.findIndex((line) => line === `  ${service}:`);
  if (start < 0) return '';
  const result: string[] = [];
  for (let i = start + 1; i < services.length; i++) {
    if (/^ {2}[a-z0-9_-]+:\s*$/.test(services[i]!)) break;
    result.push(services[i]!);
  }
  return result.join('\n');
}

describe('US-38: production deploy artifacts exist', () => {
  it('ships a production docker-compose.yml', () => {
    expect(existsSync(composePath)).toBe(true);
  });
  it('ships a multi-stage orchestrator Dockerfile', () => {
    expect(existsSync(orchDockerfile)).toBe(true);
  });
  it('ships a web Dockerfile that serves static assets', () => {
    expect(existsSync(webDockerfile)).toBe(true);
  });
  it('ships a .env.example template', () => {
    expect(existsSync(envExample)).toBe(true);
  });
});

describe('US-38: docker compose up brings up orchestrator + Postgres', () => {
  const compose = read(composePath);

  it('declares an orchestrator service', () => {
    expect(compose).toMatch(/^\s{2}orchestrator:/m);
  });

  it('declares a postgres service', () => {
    expect(compose).toMatch(/^\s{2}postgres:/m);
  });

  it('declares a web service', () => {
    expect(compose).toMatch(/^\s{2}web:/m);
  });

  it('declares the constrained browser worker', () => {
    expect(compose).toMatch(/^\s{2}browser-worker:/m);
  });

  it('orchestrator depends on postgres being healthy', () => {
    // depends_on with a health condition keeps Postgres off the boot race.
    expect(compose).toMatch(/depends_on:[\s\S]*postgres:[\s\S]*condition:\s*service_healthy/);
  });

  it('postgres has a healthcheck (pg_isready)', () => {
    expect(compose).toMatch(/pg_isready/);
  });

  it('postgres persists data to a named volume', () => {
    expect(compose).toMatch(/pgdata:\/var\/lib\/postgresql\/data/);
  });
});

describe('NFR-DEP1: Docker access is isolated behind the browser worker', () => {
  const compose = read(composePath);

  it('does NOT declare any static per-session browser/chrome service', () => {
    // browser-worker is infrastructure, not a per-session Chrome service.
    // Scope the scan to the `services:` block so top-level volumes/networks/
    // secrets keys are not mistaken for services.
    const servicesBlock = extractTopLevelBlock(compose, 'services');
    const serviceNames = Array.from(
      servicesBlock.matchAll(/^\s{2}([a-z0-9_-]+):\s*$/gm),
      (m) => m[1],
    );
    expect(serviceNames).toEqual(expect.arrayContaining(['orchestrator', 'postgres', 'web']));
    // No per-session browser/chrome service is statically declared.
    expect(servicesBlock).not.toMatch(/^\s{2}(chrome|chromium)[a-z0-9_-]*:/m);
    expect(serviceNames.sort()).toEqual([
      'browser-worker',
      'caddy',
      'orchestrator',
      'postgres',
      'web',
    ]);
  });

  it('mounts the Docker socket only into browser-worker', () => {
    expect(extractServiceBlock(compose, 'orchestrator')).not.toMatch(/\/var\/run\/docker\.sock/);
    expect(extractServiceBlock(compose, 'browser-worker')).toMatch(
      /:\s*\/var\/run\/docker\.sock\b/,
    );
    expect(compose.match(/^\s*-\s+.*:\/var\/run\/docker\.sock\b/gm)).toHaveLength(1);
  });

  it('uses a separate OS identity and token-authenticated fixed worker API', () => {
    const entry = read(browserWorkerEntrypoint);
    const orchestratorEntry = read(orchEntrypoint);
    expect(entry).toMatch(/WORKER_USER=flock-browser/);
    expect(entry).toMatch(/BROWSER_WORKER_TOKEN_FILE/);
    expect(entry).toMatch(/flock-stage-secret/);
    expect(entry).toMatch(/\/run\/flock-browser-secrets\/browser_worker_token/);
    expect(orchestratorEntry).toMatch(/flock-stage-secret/);
    expect(orchestratorEntry).toMatch(/\/run\/flock-control-secrets\/browser_worker_token/);
    expect(entry).toMatch(/dist\/browser\/worker\.js/);
    expect(extractServiceBlock(compose, 'orchestrator')).toMatch(/BROWSER_WORKER_URL/);
  });

  it('configures a browser image + concurrency cap for runtime launches', () => {
    expect(compose).toMatch(/BROWSER_IMAGE:/);
    expect(compose).toMatch(/BROWSER_MAX_CONCURRENT:/);
  });
});

describe('NFR-DEP2: secrets via env/secret files, not baked images', () => {
  const compose = read(composePath);
  const orch = read(orchDockerfile);
  const web = read(webDockerfile);
  const env = read(envExample);

  it('declares external secret files in compose', () => {
    expect(compose).toMatch(/^secrets:/m);
    expect(compose).toMatch(/flock_master_key:[\s\S]*file:\s*\.\/secrets\/flock_master_key/);
    expect(compose).toMatch(/postgres_password:[\s\S]*file:\s*\.\/secrets\/postgres_password/);
    expect(compose).toMatch(
      /browser_worker_token:[\s\S]*file:\s*\.\/secrets\/browser_worker_token/,
    );
  });

  it('stages 0600 host secrets before dropping to non-root identities', () => {
    const stager = read(secretStager);
    expect(stager).toMatch(/install -d -o root/);
    expect(stager).toMatch(/install -o "\$OWNER" -g "\$GROUP" -m "\$MODE"/);
    expect(read(orchDockerfile)).toMatch(/flock-stage-secret/);
  });

  it('supplies the master key + db creds at runtime via env/secret', () => {
    expect(compose).toMatch(/FLOCK_MASTER_KEY/);
    expect(compose).toMatch(/DATABASE_URL:/);
    expect(compose).toMatch(/POSTGRES_PASSWORD_FILE:/);
    expect(env).toMatch(/FLOCK_MASTER_KEY/);
    expect(read(orchEntrypoint)).toMatch(/DB_PASSWORD_ENCODED/);
  });

  it('does not set conflicting Postgres password env and file variables', () => {
    expect(compose).not.toMatch(/^\s+POSTGRES_PASSWORD:\s/m);
    expect(compose).toMatch(/^\s+POSTGRES_PASSWORD_FILE:\s/m);
  });

  it('does not bake secret VALUES into the Dockerfiles', () => {
    // No ENV/ARG line should assign a non-empty value to a secret-ish key.
    const secretAssign =
      /(?:ENV|ARG)\s+\w*(?:SECRET|PASSWORD|TOKEN|MASTER_KEY|PRIVATE_KEY)\w*\s*[=\s]\s*\S+/i;
    expect(secretAssign.test(orch)).toBe(false);
    expect(secretAssign.test(web)).toBe(false);
  });
});

describe('NFR-SEC1: production browser security headers', () => {
  const caddy = read(caddyfile);

  it('ships a restrictive CSP without general unsafe-eval', () => {
    expect(caddy).toMatch(/Content-Security-Policy/);
    expect(caddy).toMatch(/default-src 'self'/);
    expect(caddy).toMatch(/object-src 'none'/);
    expect(caddy).toMatch(/frame-ancestors 'none'/);
    expect(caddy).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(caddy).not.toMatch(/(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/m);
    expect(caddy).toMatch(/connect-src 'self'/);
    expect(caddy).toMatch(/upgrade-insecure-requests/);
  });

  it('documents every necessary CSP exception next to the policy', () => {
    expect(caddy).toMatch(/Ghostty needs WebAssembly/);
    expect(caddy).toMatch(/React components use[\s\S]*runtime style attributes/);
    expect(caddy).toMatch(/Screencast frames[\s\S]*data:image\/jpeg/);
  });

  it('sets permissions and cross-origin policies', () => {
    expect(caddy).toMatch(/Permissions-Policy/);
    expect(caddy).toMatch(/camera=\(\)/);
    expect(caddy).toMatch(/microphone=\(\)/);
    expect(caddy).toMatch(/Cross-Origin-Opener-Policy "same-origin"/);
    expect(caddy).toMatch(/Cross-Origin-Resource-Policy "same-origin"/);
  });
});

describe('US-38: orchestrator image is a lean multi-stage prod build', () => {
  const orch = read(orchDockerfile);

  it('uses multiple build stages', () => {
    const stages = Array.from(orch.matchAll(/^FROM\s+.+\s+AS\s+(\w+)/gim), (m) => m[1]);
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it('pins Node 22', () => {
    expect(orch).toMatch(/FROM\s+node:22/);
  });

  it('installs runtime tools the orchestrator needs (tmux, ssh, git)', () => {
    expect(orch).toMatch(/\btmux\b/);
    expect(orch).toMatch(/openssh-client/);
    expect(orch).toMatch(/\bgit\b/);
  });

  it('bundles current open-source local-node agent CLIs and fails on installer errors', () => {
    expect(orch).toMatch(/@openai\/codex@latest/);
    expect(orch).toMatch(/opencode\.ai\/install/);
    expect(orch).not.toMatch(/WARN: (codex|opencode) install skipped/);
  });

  it('checks latest Claude Code on every start without redistributing its binary', () => {
    const entry = read(orchEntrypoint);
    expect(orch).not.toMatch(/RUN[\s\S]*claude\.ai\/install\.sh/);
    expect(entry).toMatch(/claude\.ai\/install\.sh[\s\S]*bash -s -- latest/);
    expect(entry).toMatch(/FLOCK_INSTALL_CLAUDE_CODE:-1/);
    expect(entry).not.toMatch(/! -x "\$CLAUDE_BIN"/);
  });

  it('runs migrations before starting the server (via the entrypoint, T10)', () => {
    // T10 moved the boot sequence into orchestrator-entrypoint.sh (which also
    // supervises flock-agentd). Assert the entrypoint runs migrate before start.
    const entry = read(orchEntrypoint);
    expect(orch).toMatch(/flock-entrypoint\.sh/); // CMD invokes the entrypoint
    expect(entry).toMatch(
      /pnpm --filter @flock\/orchestrator run migrate[\s\S]*pnpm --filter @flock\/orchestrator run start/,
    );
  });

  it('ships + supervises flock-agentd as the local-node PTY transport (T10)', () => {
    // The single-box deploy must run the daemon in this image. Built from a Go
    // stage and copied to /usr/local/bin; the orchestrator + daemon agree on the
    // socket via FLOCK_AGENTD_SOCKET.
    expect(orch).toMatch(/AS\s+agentd-build/);
    expect(orch).toMatch(/\/usr\/local\/bin\/flock-agentd/);
    expect(orch).toMatch(/FLOCK_AGENTD_SOCKET/);
    const entry = read(orchEntrypoint);
    expect(entry).toMatch(/flock-agentd serve/);
  });

  it('ships both supported remote-node agentd architectures', () => {
    expect(orch).toMatch(/for arch in amd64 arm64/);
    expect(orch).toMatch(/flock-agentd-linux-\$arch/);
    expect(orch).toMatch(/\/app\/agentd\/dist/);
    expect(orch).toMatch(/COMPATIBILITY\.json \/app\/agentd\/COMPATIBILITY\.json/);
  });
});

describe('production node and stack lifecycle', () => {
  it('ships an idempotent privilege-separated node preparation path', () => {
    const script = read(nodePrepare);
    expect(script).toMatch(/flock-control/);
    expect(script).toMatch(/flock-agent/);
    expect(script).toMatch(/flock-node-admin/);
    expect(script).toMatch(/NOPASSWD: %s/);
    expect(script).not.toMatch(/NOPASSWD:\s*ALL/);
    expect(script).toMatch(/check-workspace/);
    expect(script).toMatch(/agent-version/);
    expect(script).toMatch(/runtime-exec-supported/);
    expect(script).toMatch(/runtime-exec/);
    expect(script).toMatch(/runuser -u "\$RUNTIME_USER" -- env -i/);
    expect(script).toMatch(/UMask=0002/);
    expect(script).toMatch(/mv -f "\$SYSTEM_BIN\.candidate" "\$SYSTEM_BIN"/);
  });

  it('makes Vagrant nodes effectively key-only even when cloud-init enables passwords', () => {
    const script = read(vagrantProvision);
    expect(script).toMatch(/00-flock-key-only\.conf/);
    expect(script).toMatch(/PasswordAuthentication no/);
    expect(script).toMatch(/KbdInteractiveAuthentication no/);
    expect(script).toMatch(/AuthenticationMethods publickey/);
    expect(script).toMatch(/sshd -t/);
  });

  it('ships a backup-gated version-coupled stack upgrade command', () => {
    const script = read(upgradeScript);
    expect(script).toMatch(/vault create/);
    expect(script).toMatch(/vault verify/);
    expect(script).toMatch(/FLOCK_VERSION/);
    expect(script).toMatch(/BROWSER_IMAGE=/);
    expect(script).toMatch(/\/ready/);
    expect(script).toMatch(/agentd-compatibility\.json/);
    expect(script).toMatch(/--acknowledge-node-policy-change/);
    expect(script).toMatch(/removedProtocols/);
    expect(script).toMatch(/addedCapabilities/);
    expect(script).not.toMatch(/docker compose down -v/);
  });
});

describe('US-38: web image builds the bundle then serves it statically', () => {
  const web = read(webDockerfile);

  it('uses a Node build stage and an nginx serve stage', () => {
    expect(web).toMatch(/FROM\s+node:22[\s\S]*AS\s+build/i);
    expect(web).toMatch(/FROM\s+nginx/i);
  });

  it('copies the built Vite dist into the served root', () => {
    expect(web).toMatch(/apps\/web\/dist/);
  });

  it('falls back to index.html for SPA routes', () => {
    expect(web).toMatch(/try_files[\s\S]*index\.html/);
  });
});

describe('US-38: docker compose config is valid (smoke, when Docker is present)', () => {
  it('parses without error', () => {
    let hasDocker = true;
    try {
      execFileSync('docker', ['--version'], { stdio: 'ignore' });
    } catch {
      hasDocker = false;
    }
    if (!hasDocker) {
      // Docker CLI not available in this runner; structural tests above cover it.
      return;
    }
    expect(() =>
      execFileSync('docker', ['compose', '-f', composePath, 'config'], {
        cwd: repoRoot,
        stdio: 'pipe',
        env: { ...process.env },
      }),
    ).not.toThrow();
  });
});
