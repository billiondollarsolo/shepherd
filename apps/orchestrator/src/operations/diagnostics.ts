import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type pg from 'pg';
import { resolveAgentdVersion } from '../runtime/agentd-version.js';
import type { DiagnosticSink } from '../runtime/diagnostics.js';
import { allowsInsecureHttp, deploymentMode } from '../auth/origin-policy.js';

const runFile = promisify(execFile);

async function toolVersion(
  ...commands: string[]
): Promise<{ status: 'available' | 'missing'; version?: string }> {
  for (const command of commands) {
    try {
      const { stdout, stderr } = await runFile(command, ['--version'], {
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      });
      const version = `${stdout}${stderr}`.trim().split('\n')[0]?.slice(0, 200);
      return { status: 'available', version: version || 'unknown' };
    } catch {
      // Try the next supported user-managed or bundled location.
    }
  }
  return { status: 'missing' };
}

export interface DiagnosticsDependencies {
  readonly pool: pg.Pool;
  readonly sink: DiagnosticSink;
  readonly agentdHealth: () => Promise<unknown>;
  readonly listNodes: () => Promise<readonly unknown[]>;
  readonly collectionSizes: () => Readonly<Record<string, number>>;
  readonly previewHealth: () => { enabled: boolean; active: number; reason: string | null };
  readonly env?: NodeJS.ProcessEnv;
  readonly workspace?: string;
}

export async function collectDiagnostics(deps: DiagnosticsDependencies): Promise<unknown> {
  const env = deps.env ?? process.env;
  const workspace = deps.workspace ?? process.cwd();
  const [database, migrations, agentd, nodes, disk, codex, claude, opencode] = await Promise.all([
    deps.pool
      .query('select 1')
      .then(() => ({ status: 'ready' as const }))
      .catch(() => ({ status: 'unavailable' as const })),
    deps.pool
      .query<{ count: string }>('select count(*)::text as count from drizzle.__drizzle_migrations')
      .then(({ rows }) => ({ status: 'ready' as const, count: Number(rows[0]?.count ?? 0) }))
      .catch(() => ({ status: 'unavailable' as const })),
    deps.agentdHealth().catch(() => ({ status: 'unavailable' })),
    deps.listNodes().catch(() => []),
    statfs(workspace)
      .then((value) => ({
        status: 'ready' as const,
        freeBytes: Number(value.bavail) * Number(value.bsize),
        totalBytes: Number(value.blocks) * Number(value.bsize),
      }))
      .catch(() => ({ status: 'unavailable' as const })),
    toolVersion('codex'),
    toolVersion(env.FLOCK_CLAUDE_BIN ?? 'claude', '/home/flock-agent/.local/bin/claude'),
    toolVersion('opencode'),
  ]);

  const warnings: string[] = [];
  const mode = deploymentMode(env);
  const privateHttp = mode === 'private-http';
  const transport = privateHttp || env.PUBLIC_BASE_URL?.startsWith('http://') ? 'http' : 'https';
  const trustedProxy = Boolean(env.FLOCK_TRUST_PROXY?.trim());
  if (mode === 'development') warnings.push('development mode is active');
  if (privateHttp && allowsInsecureHttp(env)) {
    warnings.push('Private HTTP mode is active; browser traffic is not encrypted.');
  }
  if (env.NODE_ENV === 'production' && !trustedProxy) {
    warnings.push('No trusted reverse-proxy hop is configured; client IP audit data may be wrong.');
  }
  const preview = deps.previewHealth();

  return {
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    versions: {
      flock: resolveAgentdVersion(env),
      agentdExpected: resolveAgentdVersion(env),
      agents: { codex, claude, opencode },
    },
    deployment: {
      mode,
      transport,
      publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
      trustedProxy,
    },
    health: {
      process: { status: 'ready', uptimeSeconds: Math.floor(process.uptime()) },
      database,
      migrations,
      agentd,
      nodes: { status: 'ready', count: nodes.length },
      disk,
      preview: {
        status: preview.enabled ? ('available' as const) : ('not_configured' as const),
        active: preview.active,
        reason: preview.reason,
      },
      push: { status: env.VAPID_PUBLIC_KEY ? 'configured' : 'not_configured' },
    },
    warnings,
    collections: deps.collectionSizes(),
    diagnostics: deps.sink.snapshot(),
    privacy: {
      included: 'bounded operational metadata and redacted error summaries',
      excluded: 'credentials, tokens, cookies, environment variables, and PTY content',
    },
  };
}
