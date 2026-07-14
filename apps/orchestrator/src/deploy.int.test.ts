/**
 * US-38 — Production Docker Compose deploy (TDD acceptance test).
 *
 * Verifies the production `docker-compose.yml` and the prod Dockerfiles satisfy
 * the US-38 acceptance criteria and the mapped NFRs:
 *
 *   - `docker compose up` brings up orchestrator + Postgres                (US-38)
 *   - no service receives the Docker socket; Preview is origin-isolated      (NFR-DEP1)
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
const readmePath = resolve(repoRoot, 'README.md');
const privateHttpComposePath = resolve(repoRoot, 'docker-compose.private-http.yml');
const externalProxyComposePath = resolve(repoRoot, 'docker-compose.external-proxy.yml');
const orchDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.orchestrator');
const orchEntrypoint = resolve(repoRoot, 'docker', 'orchestrator-entrypoint.sh');
const secretStager = resolve(repoRoot, 'docker', 'stage-secret.sh');
const webDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.web');
const caddyDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.caddy');
const postgresDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.postgres');
const envExample = resolve(repoRoot, '.env.example');
const caddyfile = resolve(repoRoot, 'docker', 'Caddyfile');
const privateHttpCaddyfile = resolve(repoRoot, 'docker', 'Caddyfile.private-http');
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
  it('ships security-patched edge and database Dockerfiles', () => {
    expect(existsSync(caddyDockerfile)).toBe(true);
    expect(existsSync(postgresDockerfile)).toBe(true);
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

  it('declares the TLS edge service', () => {
    expect(compose).toMatch(/^\s{2}caddy:/m);
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

describe('NFR-DEP1: Docker access is absent and Preview is isolated', () => {
  const compose = read(composePath);

  it('declares only the four production services', () => {
    const servicesBlock = extractTopLevelBlock(compose, 'services');
    const serviceNames = Array.from(
      servicesBlock.matchAll(/^\s{2}([a-z0-9_-]+):\s*$/gm),
      (m) => m[1],
    );
    expect(serviceNames.sort()).toEqual(['caddy', 'orchestrator', 'postgres', 'web']);
  });

  it('mounts no Docker socket into any service', () => {
    expect(compose).not.toMatch(/\/var\/run\/docker\.sock|DOCKER_HOST|DOCKER_SOCKET/);
  });

  it('uses a dedicated preview suffix and private gateway port', () => {
    const edgeConfig = read(caddyfile);
    expect(extractServiceBlock(compose, 'orchestrator')).toMatch(/FLOCK_PREVIEW_DOMAIN/);
    expect(extractServiceBlock(compose, 'orchestrator')).toMatch(/FLOCK_PREVIEW_PORT:\s*8081/);
    expect(extractServiceBlock(compose, 'orchestrator')).not.toMatch(/^\s+ports:/m);
    expect(edgeConfig).toMatch(/on_demand_tls[\s\S]*_shepherd\/caddy-ask/);
    expect(edgeConfig).toMatch(/\*\.\{\$FLOCK_PREVIEW_DOMAIN:preview\.localhost\}/);
    expect(edgeConfig).not.toMatch(/^\*\.preview\.localhost\s*\{/m);
  });

  it('hardens every long-running container', () => {
    for (const service of ['caddy', 'postgres', 'orchestrator', 'web']) {
      const block = extractServiceBlock(compose, service);
      expect(block).toMatch(/read_only:\s*true/);
      expect(block).toMatch(/no-new-privileges:true/);
      expect(block).toMatch(/pids_limit:/);
    }
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
    expect(compose).toMatch(/setup_token:[\s\S]*file:\s*\.\/secrets\/setup_token/);
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
  });

  it('sets permissions and cross-origin policies', () => {
    expect(caddy).toMatch(/Permissions-Policy/);
    expect(caddy).toMatch(/camera=\(\)/);
    expect(caddy).toMatch(/microphone=\(\)/);
    expect(caddy).toMatch(/Cross-Origin-Opener-Policy "same-origin"/);
    expect(caddy).toMatch(/Cross-Origin-Resource-Policy "same-origin"/);
  });
});

describe('explicit deployment modes', () => {
  const compose = read(composePath);
  const privateCompose = read(privateHttpComposePath);
  const externalCompose = read(externalProxyComposePath);
  const privateCaddy = read(privateHttpCaddyfile);

  it('keeps bundled TLS as the base-stack default', () => {
    expect(extractServiceBlock(compose, 'orchestrator')).toMatch(
      /FLOCK_DEPLOYMENT_MODE:\s*builtin-tls/,
    );
    expect(extractServiceBlock(compose, 'caddy')).toMatch(/'\$\{HTTPS_HOST_PORT:-443\}:443'/);
  });

  it('requires an explicit acknowledgement for private HTTP', () => {
    expect(privateCompose).toMatch(/FLOCK_DEPLOYMENT_MODE:\s*private-http/);
    expect(privateCompose).toMatch(/FLOCK_ALLOW_INSECURE_HTTP:\s*\$\{[^}]+:\?/);
    expect(privateCompose).toMatch(/Caddyfile\.private-http/);
    expect(privateCaddy).not.toMatch(/^\s*Strict-Transport-Security\s/m);
    expect(privateCaddy).not.toMatch(/Content-Security-Policy[^\n]*upgrade-insecure-requests/);
    expect(privateCaddy).toMatch(/Content-Security-Policy/);
    expect(privateCaddy).toMatch(/preview\.invalid/);
  });

  it('publishes a bounded Preview-only port pool for no-DNS private deployments', () => {
    const orchestrator = extractServiceBlock(privateCompose, 'orchestrator');
    expect(orchestrator).toMatch(/FLOCK_PREVIEW_BACKEND:\s*\$\{FLOCK_PREVIEW_BACKEND:-port-pool\}/);
    expect(orchestrator).toMatch(
      /FLOCK_PREVIEW_PORT_RANGE:\s*\$\{FLOCK_PREVIEW_PORT_RANGE:-12000-12031\}/,
    );
    expect(orchestrator).toMatch(/FLOCK_PREVIEW_POOL_HOST:\s*0\.0\.0\.0/);
    expect(orchestrator).toMatch(
      /\$\{FLOCK_PREVIEW_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{FLOCK_PREVIEW_PORT_RANGE:-12000-12031\}:\$\{FLOCK_PREVIEW_PORT_RANGE:-12000-12031\}/,
    );
    expect(extractServiceBlock(privateCompose, 'caddy')).not.toMatch(/12000-12031/);
  });

  it('fails embedded private Preview closed unless finite frame origins are configured', () => {
    expect(privateCaddy).toMatch(/frame-src \{\$FLOCK_PREVIEW_FRAME_SOURCES:'none'\}/);
    expect(privateCaddy).not.toMatch(/frame-src\s+(?:\*|https?:)(?:[;"\s]|$)/);
    expect(extractServiceBlock(privateCompose, 'orchestrator')).toMatch(
      /FLOCK_PREVIEW_FRAME_SOURCES/,
    );
  });

  it('binds external-proxy upstreams to loopback by default and retains TLS policy', () => {
    expect(externalCompose).toMatch(/FLOCK_DEPLOYMENT_MODE:\s*external-tls/);
    expect(externalCompose).toMatch(/FLOCK_PROXY_BIND_ADDRESS:-127\.0\.0\.1/);
    expect(externalCompose).toMatch(/18080}:8080/);
    expect(externalCompose).toMatch(/18081}:80/);
    expect(externalCompose).toMatch(/18082}:8081/);
  });
});

describe('public deployment guidance', () => {
  const readme = read(readmePath);

  it('offers copy-paste paths for each supported edge mode', () => {
    expect(readme).toMatch(/public domain with automatic TLS/i);
    expect(readme).toMatch(/docker-compose\.external-proxy\.yml up -d --wait/);
    expect(readme).toMatch(/docker-compose\.private-http\.yml up -d --wait/);
    expect(readme).toMatch(/FLOCK_ALLOW_INSECURE_HTTP=1/);
    expect(readme).toMatch(/Private DNS with HTTP and Remote Preview/);
  });

  it('documents custom topology freedom without hiding the risk', () => {
    expect(readme).toMatch(/You own the deployment/);
    expect(readme).toMatch(/credentials and sessions can be intercepted/);
    expect(readme).toMatch(/orchestrator:8080/);
    expect(readme).toMatch(/web:80/);
    expect(readme).toMatch(/orchestrator:8081/);
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

  it('installs runtime tools the orchestrator needs without legacy tmux', () => {
    expect(orch).not.toMatch(/^\s*tmux\s*\\/m);
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
    expect(script).not.toMatch(/BROWSER_IMAGE=/);
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

  it('parses the private HTTP and external proxy overrides', () => {
    let hasDocker = true;
    try {
      execFileSync('docker', ['--version'], { stdio: 'ignore' });
    } catch {
      hasDocker = false;
    }
    if (!hasDocker) return;

    const common = {
      cwd: repoRoot,
      stdio: 'pipe' as const,
      env: {
        ...process.env,
        PUBLIC_BASE_URL: 'http://100.64.0.1:11010',
        FLOCK_ALLOWED_ORIGINS: 'http://100.64.0.1:11010',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
      },
    };
    expect(() =>
      execFileSync(
        'docker',
        ['compose', '-f', composePath, '-f', privateHttpComposePath, 'config'],
        common,
      ),
    ).not.toThrow();
    expect(() =>
      execFileSync(
        'docker',
        ['compose', '-f', composePath, '-f', externalProxyComposePath, 'config'],
        {
          ...common,
          env: {
            ...common.env,
            PUBLIC_BASE_URL: 'https://shepherd.example.com',
            FLOCK_ALLOWED_ORIGINS: 'https://shepherd.example.com',
          },
        },
      ),
    ).not.toThrow();
  });
});
