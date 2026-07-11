/**
 * US-38 — Production Docker Compose deploy (TDD acceptance test).
 *
 * Verifies the production `docker-compose.yml` and the prod Dockerfiles satisfy
 * the US-38 acceptance criteria and the mapped NFRs:
 *
 *   - `docker compose up` brings up orchestrator + Postgres                (US-38)
 *   - per-session browser containers are managed DYNAMICALLY, i.e. they are
 *     NOT declared as compose services and the Docker socket is mounted      (NFR-DEP1)
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
const webDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.web');
const envExample = resolve(repoRoot, '.env.example');
const caddyfile = resolve(repoRoot, 'docker', 'Caddyfile');

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

describe('NFR-DEP1: per-session browser containers managed dynamically', () => {
  const compose = read(composePath);

  it('does NOT declare any static per-session browser/chrome service', () => {
    // Per-session browser containers are launched at runtime via dockerode,
    // never declared as compose services (NFR-DEP1). The core services are
    // orchestrator + postgres + web; US-39 adds a `caddy` TLS proxy in front
    // (NFR-SEC1). What matters here is that NO static browser/chrome service is
    // declared and the known infra services are exactly the core trio + caddy.
    // Scope the scan to the `services:` block so top-level volumes/networks/
    // secrets keys are not mistaken for services.
    const servicesBlock = extractTopLevelBlock(compose, 'services');
    const serviceNames = Array.from(
      servicesBlock.matchAll(/^\s{2}([a-z0-9_-]+):\s*$/gm),
      (m) => m[1],
    );
    expect(serviceNames).toEqual(expect.arrayContaining(['orchestrator', 'postgres', 'web']));
    // No per-session browser/chrome service is statically declared.
    expect(servicesBlock).not.toMatch(/^\s{2}(browser|chrome|chromium)[a-z0-9_-]*:/m);
    // The only services are the core trio plus the US-39 Caddy TLS proxy — a
    // rogue extra service would still fail this.
    expect(serviceNames.sort()).toEqual(['caddy', 'orchestrator', 'postgres', 'web']);
  });

  it('mounts the Docker socket into the orchestrator for dockerode', () => {
    // The socket is bind-mounted to the container target /var/run/docker.sock.
    // The host side may be parameterised (e.g.
    // `${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock`), so assert
    // on the mount TARGET rather than a literal host:container string.
    expect(compose).toMatch(/:\s*\/var\/run\/docker\.sock\b/);
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

  it('installs latest Claude Code at first start without redistributing its binary', () => {
    const entry = read(orchEntrypoint);
    expect(orch).not.toMatch(/RUN[\s\S]*claude\.ai\/install\.sh/);
    expect(entry).toMatch(/claude\.ai\/install\.sh[\s\S]*bash -s -- latest/);
    expect(entry).toMatch(/FLOCK_INSTALL_CLAUDE_CODE:-1/);
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
