import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { FlockVaultManifestSchema, type FlockVaultManifest } from '@flock/shared';
import { getDatabaseUrl, createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resolveAgentdVersion } from '../runtime/agentd-version.js';
import { Keyring, resolveKeyVersion } from '../secrets/keyring.js';
import { decryptVaultPayload, encryptVaultPayload } from './vault-format.js';

const runFile = promisify(execFile);
const { Pool } = pg;

interface DatabaseTarget {
  readonly url: URL;
  readonly database: string;
  readonly env: NodeJS.ProcessEnv;
}

function databaseTarget(raw: string): DatabaseTarget {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error('DATABASE_URL must name a database');
  return {
    url,
    database,
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get('sslmode') ?? undefined,
    },
  };
}

async function tool(command: string, args: readonly string[], env = process.env): Promise<void> {
  try {
    await runFile(command, [...args], { env, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(
      `${command} failed: ${(detail.stderr || detail.message || 'unknown error').trim()}`,
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function masterKeyMetadata(env: NodeJS.ProcessEnv): FlockVaultManifest['masterKey'] {
  const currentVersion = resolveKeyVersion(env);
  const key = new Keyring(env, currentVersion).currentKey();
  return {
    currentVersion,
    fingerprint: `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`,
    requiredVersions: [],
  };
}

async function databaseMetadata(databaseUrl: string): Promise<{
  migrationCount: number;
  recordCounts: Record<string, number>;
  requiredVersions: number[];
}> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    const recordCounts: Record<string, number> = {};
    for (const { table_name: table } of tables.rows) {
      if (!/^[a-z_]+$/.test(table)) continue;
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from "${table}"`,
      );
      recordCounts[table] = Number(result.rows[0]?.count ?? 0);
    }
    const migration = await pool
      .query<{ count: string }>(`select count(*)::text as count from drizzle.__drizzle_migrations`)
      .catch(() => ({ rows: [{ count: '0' }] }));
    const versions = await pool
      .query<{
        key_version: number;
      }>('select distinct key_version from secrets order by key_version')
      .catch(() => ({ rows: [] }));
    return {
      migrationCount: Number(migration.rows[0]?.count ?? 0),
      recordCounts,
      requiredVersions: versions.rows.map(({ key_version }) => key_version),
    };
  } finally {
    await pool.end();
  }
}

export interface CreateVaultOptions {
  readonly output: string;
  readonly password: Buffer;
  readonly databaseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export async function createVault(options: CreateVaultOptions): Promise<FlockVaultManifest> {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl(options.env);
  const env = options.env ?? process.env;
  const target = databaseTarget(databaseUrl);
  const work = await mkdtemp(join(tmpdir(), 'flock-vault-create-'));
  await chmod(work, 0o700);
  const dump = join(work, 'database.dump');
  const manifestPath = join(work, 'manifest.json');
  const payload = join(work, 'payload.tar.gz');
  const partial = `${options.output}.partial-${process.pid}-${randomUUID()}`;
  let complete = false;
  let ownsOutput = false;
  try {
    const reservation = await open(options.output, 'wx', 0o600);
    ownsOutput = true;
    await reservation.close();
    await tool(
      'pg_dump',
      [
        '--format=custom',
        '--compress=6',
        '--no-owner',
        '--no-privileges',
        '--file',
        dump,
        target.database,
      ],
      target.env,
    );
    const metadata = await databaseMetadata(databaseUrl);
    const key = masterKeyMetadata(env);
    key.requiredVersions = metadata.requiredVersions;
    const dumpStat = await stat(dump);
    const manifest = FlockVaultManifestSchema.parse({
      formatVersion: 1,
      flockVersion: resolveAgentdVersion(env),
      createdAt: (options.now ?? new Date()).toISOString(),
      migrationCount: metadata.migrationCount,
      database: {
        format: 'pg-custom',
        bytes: dumpStat.size,
        sha256: await sha256File(dump),
        recordCounts: metadata.recordCounts,
      },
      masterKey: key,
      included: [
        'PostgreSQL system of record',
        'encrypted credential envelopes',
        'owner preferences, Pens, sessions, events, and audit metadata',
      ],
      excluded: [
        'master keys (must be backed up separately)',
        'live PTY processes and in-memory terminal buffers',
        'node filesystems and worktrees',
        'Caddy ACME state and TLS private keys',
      ],
      liveSessionSemantics: 'metadata-only-processes-reconciled',
      deployment: {
        mode:
          env.FLOCK_DEPLOYMENT_MODE ??
          (env.NODE_ENV === 'production' ? 'docker-compose' : 'development'),
        declaredDurableVolumes: [
          { name: 'pgdata', disposition: 'captured' },
          { name: 'flock_agent_home', disposition: 'external-backup-required' },
          { name: 'flock_agentd_state', disposition: 'reconciled' },
          { name: 'caddy_data', disposition: 'external-backup-required' },
          { name: 'caddy_config', disposition: 'external-backup-required' },
          { name: 'backups', disposition: 'external-backup-required' },
        ],
      },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await tool('tar', ['-czf', payload, '-C', work, 'manifest.json', 'database.dump']);
    await encryptVaultPayload(payload, partial, options.password);
    await rename(partial, options.output);
    await verifyVault(options.output, options.password);
    complete = true;
    return manifest;
  } finally {
    await rm(partial, { force: true });
    if (!complete && ownsOutput) await rm(options.output, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}

interface OpenedVault {
  readonly work: string;
  readonly manifest: FlockVaultManifest;
  readonly dump: string;
}

async function openVault(input: string, password: Buffer): Promise<OpenedVault> {
  const work = await mkdtemp(join(tmpdir(), 'flock-vault-open-'));
  await chmod(work, 0o700);
  const payload = join(work, 'payload.tar.gz');
  try {
    await decryptVaultPayload(input, payload, password);
    const listing = (await runFile('tar', ['-tzf', payload], { maxBuffer: 1024 * 1024 })).stdout
      .split('\n')
      .filter(Boolean);
    if (
      listing.length !== 2 ||
      !listing.includes('manifest.json') ||
      !listing.includes('database.dump') ||
      listing.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
    ) {
      throw new Error('Vault contents are incomplete or unsafe');
    }
    await tool('tar', ['-xzf', payload, '-C', work, '--no-same-owner', '--no-same-permissions']);
    const manifest = FlockVaultManifestSchema.parse(
      JSON.parse(await readFile(join(work, 'manifest.json'), 'utf8')),
    );
    const dump = join(work, 'database.dump');
    const dumpStat = await stat(dump);
    if (
      dumpStat.size !== manifest.database.bytes ||
      (await sha256File(dump)) !== manifest.database.sha256
    ) {
      throw new Error('Vault database checksum does not match its manifest');
    }
    await tool('pg_restore', ['--list', dump]);
    return { work, manifest, dump };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyVault(input: string, password: Buffer): Promise<FlockVaultManifest> {
  const opened = await openVault(input, password);
  try {
    return opened.manifest;
  } finally {
    await rm(opened.work, { recursive: true, force: true });
  }
}

function quotedIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

function databaseUrlFor(target: DatabaseTarget, database: string): string {
  const url = new URL(target.url);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function assertCompatible(manifest: FlockVaultManifest, env: NodeJS.ProcessEnv): void {
  const current = resolveAgentdVersion(env);
  if (manifest.flockVersion.split('.')[0] !== current.split('.')[0]) {
    throw new Error(
      `Vault from Shepherd ${manifest.flockVersion} is incompatible with Shepherd ${current}`,
    );
  }
  const actual = masterKeyMetadata(env);
  if (actual.fingerprint !== manifest.masterKey.fingerprint) {
    throw new Error(
      `Master key mismatch: this vault requires key fingerprint ${manifest.masterKey.fingerprint}`,
    );
  }
  for (const version of manifest.masterKey.requiredVersions) {
    new Keyring(env, manifest.masterKey.currentVersion).keyForVersion(version);
  }
}

export interface RestoreVaultOptions {
  readonly input: string;
  readonly password: Buffer;
  readonly rollbackOutput: string;
  readonly databaseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowActiveConnections?: boolean;
  /** @internal Fault-injection/extended validation seam; default validates core tables. */
  readonly validateRestored?: (pool: pg.Pool) => Promise<void>;
}

export async function restoreVault(options: RestoreVaultOptions): Promise<{
  manifest: FlockVaultManifest;
  rollbackDatabase: string;
}> {
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl(env);
  const target = databaseTarget(databaseUrl);
  const opened = await openVault(options.input, options.password);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const temporary = `flock_restore_${suffix}`;
  const rollbackDatabase = `flock_rollback_${suffix}`;
  const adminUrl = databaseUrlFor(target, 'postgres');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let originalRenamed = false;
  let restoredRenamed = false;
  let dropTemporary = true;
  try {
    assertCompatible(opened.manifest, env);
    // A separately verified rollback archive is mandatory before any mutation.
    await createVault({
      output: options.rollbackOutput,
      password: options.password,
      databaseUrl,
      env,
    });
    await admin.query(`create database ${quotedIdentifier(temporary)} template template0`);
    await tool(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', temporary, opened.dump],
      target.env,
    );
    const tempUrl = databaseUrlFor(target, temporary);
    const tempHandle = createDb(tempUrl);
    try {
      await runMigrations(tempHandle);
      await tempHandle.pool.query('select 1');
      for (const [table, expected] of Object.entries(opened.manifest.database.recordCounts)) {
        const result = await tempHandle.pool.query<{ count: string }>(
          `select count(*)::text as count from "${table}"`,
        );
        if (Number(result.rows[0]?.count ?? -1) !== expected) {
          throw new Error(`Restored record count mismatch for ${table}`);
        }
      }
    } finally {
      await tempHandle.pool.end();
    }

    const active = await admin.query<{ count: string }>(
      'select count(*)::text as count from pg_stat_activity where datname = $1',
      [target.database],
    );
    if (Number(active.rows[0]?.count ?? 0) > 0 && !options.allowActiveConnections) {
      throw new Error('Restore refused: stop the orchestrator or pass --allow-active explicitly');
    }
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [
      target.database,
    ]);
    await admin.query(
      `alter database ${quotedIdentifier(target.database)} rename to ${quotedIdentifier(rollbackDatabase)}`,
    );
    originalRenamed = true;
    await admin.query(
      `alter database ${quotedIdentifier(temporary)} rename to ${quotedIdentifier(target.database)}`,
    );
    restoredRenamed = true;
    const validation = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      if (options.validateRestored) await options.validateRestored(validation);
      else {
        await validation.query('select 1');
        await validation.query('select count(*) from users');
      }
    } finally {
      await validation.end();
    }
    return { manifest: opened.manifest, rollbackDatabase };
  } catch (error) {
    let rollbackError: unknown;
    if (originalRenamed) {
      if (restoredRenamed) {
        try {
          await admin.query(
            'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1',
            [target.database],
          );
          await admin.query(
            `alter database ${quotedIdentifier(target.database)} rename to ${quotedIdentifier(temporary)}`,
          );
          restoredRenamed = false;
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      if (!rollbackError) {
        try {
          await admin.query(
            `alter database ${quotedIdentifier(rollbackDatabase)} rename to ${quotedIdentifier(target.database)}`,
          );
          originalRenamed = false;
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
          // Retain the verified temporary database if the old active database
          // could not be put back; deleting it would make recovery harder.
          dropTemporary = false;
        }
      }
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Restore failed and automatic rollback was incomplete. The prior database is ${rollbackDatabase}; operator recovery is required.`,
      );
    }
    throw error;
  } finally {
    if (!restoredRenamed && dropTemporary) {
      await admin
        .query(`drop database if exists ${quotedIdentifier(temporary)} with (force)`)
        .catch(() => undefined);
    }
    await admin.end();
    await rm(opened.work, { recursive: true, force: true });
  }
}

export function defaultRollbackPath(vault: string): string {
  return join(dirname(vault), `${basename(vault)}.pre-restore-${Date.now()}.flockvault`);
}
