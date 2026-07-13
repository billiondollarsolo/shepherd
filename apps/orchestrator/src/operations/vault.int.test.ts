import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createVault, restoreVault, verifyVault } from './vault';

const { Pool } = pg;
const baseUrl = process.env.DATABASE_URL!;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const sourceName = `flock_vault_source_${suffix}`;
const targetName = `flock_vault_target_${suffix}`;
const createdDatabases = new Set([sourceName, targetName]);
let work = '';

function urlFor(database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function provision(database: string): Promise<void> {
  const adminUrl = urlFor('postgres');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`create database "${database}" template template0`);
  await admin.end();
  const handle = createDb(urlFor(database));
  await runMigrations(handle);
  await handle.pool.end();
}

describe('Shepherd vault backup and isolated restore', () => {
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'flock-vault-int-'));
    await provision(sourceName);
    await provision(targetName);
  }, 60_000);

  afterAll(async () => {
    const admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    for (const database of createdDatabases) {
      await admin
        .query(`drop database if exists "${database}" with (force)`)
        .catch(() => undefined);
    }
    await admin.end();
    await rm(work, { recursive: true, force: true });
  }, 60_000);

  it('backs up, verifies, restores through a temporary database, and retains rollback', async () => {
    const source = new Pool({ connectionString: urlFor(sourceName), max: 1 });
    await source.query(
      `insert into users (username, password_hash) values ('source-owner', 'argon-hash')`,
    );
    await source.end();
    const target = new Pool({ connectionString: urlFor(targetName), max: 1 });
    await target.query(
      `insert into users (username, password_hash) values ('target-owner', 'argon-hash')`,
    );
    await target.end();

    const archive = join(work, 'source.flockvault');
    const rollback = join(work, 'target-rollback.flockvault');
    const password = Buffer.from('integration-vault-password');
    const env = {
      ...process.env,
      FLOCK_AGENTD_VERSION: '0.3.0',
      FLOCK_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      FLOCK_MASTER_KEY_VERSION: '0',
    };
    await createVault({ output: archive, password, databaseUrl: urlFor(sourceName), env });
    expect((await verifyVault(archive, password)).database.recordCounts.users).toBe(1);

    const restored = await restoreVault({
      input: archive,
      password,
      rollbackOutput: rollback,
      databaseUrl: urlFor(targetName),
      env,
      allowActiveConnections: true,
    });
    createdDatabases.add(restored.rollbackDatabase);
    const live = new Pool({ connectionString: urlFor(targetName), max: 1 });
    expect((await live.query<{ username: string }>('select username from users')).rows).toEqual([
      { username: 'source-owner' },
    ]);
    await live.end();
    expect((await verifyVault(rollback, password)).database.recordCounts.users).toBe(1);
  }, 60_000);

  it('rejects the wrong master key before changing the target database', async () => {
    const archive = join(work, 'wrong-key.flockvault');
    const password = Buffer.from('integration-vault-password');
    const goodEnv = {
      ...process.env,
      FLOCK_AGENTD_VERSION: '0.3.0',
      FLOCK_MASTER_KEY: Buffer.alloc(32, 8).toString('base64'),
    };
    await createVault({ output: archive, password, databaseUrl: urlFor(sourceName), env: goodEnv });
    await expect(
      restoreVault({
        input: archive,
        password,
        rollbackOutput: join(work, 'must-not-exist.flockvault'),
        databaseUrl: urlFor(targetName),
        env: { ...goodEnv, FLOCK_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') },
        allowActiveConnections: true,
      }),
    ).rejects.toThrow(/Master key mismatch/);
  }, 60_000);

  it('rejects an incompatible Shepherd version before creating a rollback or changing data', async () => {
    const archive = join(work, 'wrong-version.flockvault');
    const rollback = join(work, 'wrong-version-rollback.flockvault');
    const password = Buffer.from('integration-vault-password');
    const key = Buffer.alloc(32, 8).toString('base64');
    await createVault({
      output: archive,
      password,
      databaseUrl: urlFor(sourceName),
      env: { ...process.env, FLOCK_AGENTD_VERSION: '1.0.0', FLOCK_MASTER_KEY: key },
    });
    await expect(
      restoreVault({
        input: archive,
        password,
        rollbackOutput: rollback,
        databaseUrl: urlFor(targetName),
        env: { ...process.env, FLOCK_AGENTD_VERSION: '0.3.0', FLOCK_MASTER_KEY: key },
        allowActiveConnections: true,
      }),
    ).rejects.toThrow(/incompatible/);
    await expect(access(rollback)).rejects.toThrow();
  }, 60_000);

  it('rolls the active database back if post-cutover validation fails', async () => {
    const source = new Pool({ connectionString: urlFor(sourceName), max: 1 });
    const target = new Pool({ connectionString: urlFor(targetName), max: 1 });
    await target.query('delete from users');
    await target.query(
      `insert into users (username, password_hash) values ('before-failure', 'hash')`,
    );
    await target.end();
    const archive = join(work, 'rollback-source.flockvault');
    const password = Buffer.from('integration-vault-password');
    const env = {
      ...process.env,
      FLOCK_AGENTD_VERSION: '0.3.0',
      FLOCK_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    };
    await createVault({ output: archive, password, databaseUrl: urlFor(sourceName), env });
    await source.end();
    await expect(
      restoreVault({
        input: archive,
        password,
        rollbackOutput: join(work, 'pre-failed-cutover.flockvault'),
        databaseUrl: urlFor(targetName),
        env,
        allowActiveConnections: true,
        validateRestored: async () => {
          throw new Error('injected post-cutover failure');
        },
      }),
    ).rejects.toThrow(/injected post-cutover failure/);
    const after = new Pool({ connectionString: urlFor(targetName), max: 1 });
    expect((await after.query<{ username: string }>('select username from users')).rows).toEqual([
      { username: 'before-failure' },
    ]);
    await after.end();
  }, 60_000);
});
