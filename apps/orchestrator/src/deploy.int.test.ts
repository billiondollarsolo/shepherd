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
const cloudflareDnsComposePath = resolve(repoRoot, 'docker-compose.dns-cloudflare.yml');
const route53DnsComposePath = resolve(repoRoot, 'docker-compose.dns-route53.yml');
const orchDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.orchestrator');
const orchEntrypoint = resolve(repoRoot, 'docker', 'orchestrator-entrypoint.sh');
const runtimeDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.node-runtime');
const runtimeEntrypoint = resolve(repoRoot, 'docker', 'node-runtime-entrypoint.sh');
const secretStager = resolve(repoRoot, 'docker', 'stage-secret.sh');
const webDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.web');
const caddyDockerfile = resolve(repoRoot, 'docker', 'Dockerfile.caddy');
const caddyEntrypoint = resolve(repoRoot, 'docker', 'caddy-entrypoint.sh');
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
  it('ships the isolated local runtime image and entrypoint', () => {
    expect(existsSync(runtimeDockerfile)).toBe(true);
    expect(existsSync(runtimeEntrypoint)).toBe(true);
  });
  it('ships a web Dockerfile that serves static assets', () => {
    expect(existsSync(webDockerfile)).toBe(true);
  });
  it('ships security-patched edge and database Dockerfiles', () => {
    expect(existsSync(caddyDockerfile)).toBe(true);
    expect(existsSync(postgresDockerfile)).toBe(true);
  });
  it('ships optional Cloudflare and Route53 DNS-01 profiles', () => {
    expect(existsSync(cloudflareDnsComposePath)).toBe(true);
    expect(existsSync(route53DnsComposePath)).toBe(true);
    expect(existsSync(caddyEntrypoint)).toBe(true);
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

  it('declares an authenticated isolated node runtime dependency', () => {
    expect(compose).toMatch(/^\s{2}node-runtime:/m);
    expect(extractServiceBlock(compose, 'orchestrator')).toMatch(
      /node-runtime:[\s\S]*condition:\s*service_healthy/,
    );
    expect(extractServiceBlock(compose, 'node-runtime')).toMatch(
      /- flock-agentd[\s\S]*- probe[\s\S]*--secret-file/,
    );
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

  it('declares only the five production services', () => {
    const servicesBlock = extractTopLevelBlock(compose, 'services');
    const serviceNames = Array.from(
      servicesBlock.matchAll(/^\s{2}([a-z0-9_-]+):\s*$/gm),
      (m) => m[1],
    );
    expect(serviceNames.sort()).toEqual([
      'caddy',
      'node-runtime',
      'orchestrator',
      'postgres',
      'web',
    ]);
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
    for (const service of ['caddy', 'node-runtime', 'postgres', 'orchestrator', 'web']) {
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
    expect(caddy).toMatch(/connect-src 'self' data:/);
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
  const cloudflareDnsCompose = read(cloudflareDnsComposePath);
  const route53DnsCompose = read(route53DnsComposePath);

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
    expect(privateCaddy).not.toMatch(/Cross-Origin-Opener-Policy/);
    expect(privateCaddy).toMatch(/Content-Security-Policy/);
    expect(privateCaddy).toMatch(/connect-src 'self' data:/);
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

  it('builds pinned DNS providers and loads their credentials from secret files', () => {
    const edgeImage = read(caddyDockerfile);
    const entrypoint = read(caddyEntrypoint);
    expect(edgeImage).toMatch(/xcaddy\/cmd\/xcaddy@v0\.4\.6/);
    expect(edgeImage).toMatch(/caddy-dns\/cloudflare@v0\.2\.4/);
    expect(edgeImage).toMatch(/caddy-dns\/route53@v1\.6\.2/);
    expect(edgeImage).toMatch(/\/out\/licenses \/usr\/share\/licenses\/shepherd\/edge\//);
    expect(read(caddyfile)).toMatch(/import \/tmp\/shepherd-dns-provider\.caddy/);
    expect(cloudflareDnsCompose).toMatch(/CF_API_TOKEN_FILE:\s*\/run\/secrets\//);
    expect(route53DnsCompose).toMatch(/AWS_ACCESS_KEY_ID_FILE:\s*\/run\/secrets\//);
    expect(route53DnsCompose).toMatch(/AWS_SECRET_ACCESS_KEY_FILE:\s*\/run\/secrets\//);
    expect(entrypoint).toMatch(/acme_dns cloudflare \{env\.CF_API_TOKEN\}/);
    expect(entrypoint).toMatch(/acme_dns route53/);
    expect(cloudflareDnsCompose).not.toMatch(/^\s+CF_API_TOKEN:\s/m);
    expect(route53DnsCompose).not.toMatch(/^\s+AWS_SECRET_ACCESS_KEY:\s/m);
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
    expect(readme).toMatch(/Optional DNS-01 with Cloudflare or Route53/);
    expect(readme).toMatch(/docker-compose\.dns-cloudflare\.yml/);
    expect(readme).toMatch(/docker-compose\.dns-route53\.yml/);
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

  it('keeps only control-plane tools and no legacy local PTY runtime', () => {
    expect(orch).not.toMatch(/^\s*tmux\s*\\/m);
    expect(orch).toMatch(/openssh-client/);
    expect(orch).not.toMatch(/node-pty/);
  });

  it('moves coding-agent CLIs exclusively into node-runtime', () => {
    const runtime = read(runtimeDockerfile);
    expect(runtime).toMatch(/@openai\/codex@latest/);
    expect(runtime).toMatch(/opencode\.ai\/install/);
    expect(orch).not.toMatch(/@openai\/codex|opencode\.ai\/install/);
  });

  it('performs a bounded best-effort latest Claude update only in runtime', () => {
    const entry = read(runtimeEntrypoint);
    expect(entry).toMatch(/claude\.ai\/install\.sh[\s\S]*bash/);
    expect(entry).toMatch(/timeout 120/);
    expect(read(orchEntrypoint)).not.toMatch(/claude\.ai\/install\.sh/);
  });

  it('runs migrations before starting the server (via the entrypoint, T10)', () => {
    // The control-plane entrypoint only stages secrets, migrates, and starts.
    const entry = read(orchEntrypoint);
    expect(orch).toMatch(/flock-entrypoint\.sh/); // CMD invokes the entrypoint
    expect(entry).toMatch(
      /pnpm --filter @flock\/orchestrator run migrate[\s\S]*pnpm --filter @flock\/orchestrator run start/,
    );
  });

  it('keeps remote daemon artifacts but never supervises a local daemon', () => {
    expect(orch).toMatch(/AS\s+agentd-build/);
    expect(orch).not.toMatch(/\/usr\/local\/bin\/flock-agentd/);
    expect(read(orchEntrypoint)).not.toMatch(/flock-agentd serve/);
    expect(read(runtimeDockerfile)).toMatch(/\/usr\/local\/bin\/flock-agentd/);
    expect(read(runtimeEntrypoint)).toMatch(/exec env -i[\s\S]*flock-agentd serve/);
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

  it('ships a bundle-validated, backup-gated, runtime-aware upgrade command', () => {
    const script = read(upgradeScript);
    expect(script).toMatch(/vault create/);
    expect(script).toMatch(/vault verify/);
    expect(script).toMatch(/FLOCK_VERSION/);
    expect(script).not.toMatch(/BROWSER_IMAGE=/);
    expect(script).toMatch(/\/ready/);
    expect(script).toMatch(/shepherd-deployment-\$TARGET\.tar\.gz/);
    expect(script).toMatch(/gh attestation verify/);
    expect(script).toMatch(/FLOCK_NODE_RUNTIME_VERSION/);
    expect(script).toMatch(/--force-stop-local-sessions/);
    expect(script).toMatch(/flock-agentd inspect/);
    expect(script).toMatch(/--acknowledge-node-policy-change/);
    expect(script).toMatch(/docker compose pull "\$\{pull\[@\]\}"/);
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

  it('parses both DNS-01 provider overrides without embedding credential values', () => {
    let hasDocker = true;
    try {
      execFileSync('docker', ['--version'], { stdio: 'ignore' });
    } catch {
      hasDocker = false;
    }
    if (!hasDocker) return;

    const env = {
      ...process.env,
      CLOUDFLARE_API_TOKEN_FILE: '/dev/null',
      ROUTE53_ACCESS_KEY_ID_FILE: '/dev/null',
      ROUTE53_SECRET_ACCESS_KEY_FILE: '/dev/null',
    };
    for (const override of [cloudflareDnsComposePath, route53DnsComposePath]) {
      expect(() =>
        execFileSync('docker', ['compose', '-f', composePath, '-f', override, 'config'], {
          cwd: repoRoot,
          stdio: 'pipe',
          env,
        }),
      ).not.toThrow();
    }
  });
});
