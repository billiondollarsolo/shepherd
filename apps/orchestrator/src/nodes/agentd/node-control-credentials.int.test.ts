import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { nodes, secrets } from '../../db/schema.js';
import { Keyring } from '../../secrets/keyring.js';
import { SecretStore } from '../../secrets/secret-store.js';
import { NodeControlCredentials } from './node-control-credentials.js';

let handle: DbHandle;
let secretStore: SecretStore;

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  secretStore = new SecretStore({
    keyring: new Keyring({ FLOCK_MASTER_KEY: 'c'.repeat(64) }),
  });
});

afterAll(async () => {
  await handle?.pool.end();
});

describe('per-node agentd control credentials', () => {
  it('generates unique credentials, encrypts them, and reuses the durable value', async () => {
    const [firstNode, secondNode] = await handle.db
      .insert(nodes)
      .values([
        {
          name: `control-a-${randomUUID()}`,
          kind: 'ssh',
          connectionStatus: 'disconnected',
        },
        {
          name: `control-b-${randomUUID()}`,
          kind: 'ssh',
          connectionStatus: 'disconnected',
        },
      ])
      .returning();
    const credentials = new NodeControlCredentials({ db: handle.db, secrets: secretStore });
    const first = await credentials.forNode(firstNode!.id, 'ssh');
    const second = await credentials.forNode(secondNode!.id, 'ssh');

    expect(first.nodeId).toBe(firstNode!.id);
    expect(second.nodeId).toBe(secondNode!.id);
    expect(first.credential).not.toBe(second.credential);
    expect(first.credential.length).toBeGreaterThanOrEqual(32);
    await expect(credentials.forNode(firstNode!.id, 'ssh')).resolves.toEqual(first);

    const [storedNode] = await handle.db.select().from(nodes).where(eq(nodes.id, firstNode!.id));
    const [storedSecret] = await handle.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, storedNode!.agentdCredentialRef!));
    expect(storedSecret!.kind).toBe('agentd_control');
    expect(Buffer.from(storedSecret!.ciphertext).toString('utf8')).not.toContain(first.credential);
  });

  it('mirrors the protected local files and fails closed on later mismatch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flock-local-control-test-'));
    const credentialFile = path.join(dir, 'control.key');
    const identityFile = path.join(dir, 'node-id');
    const credential = 'local-node-control-credential-at-least-32-bytes';
    const daemonNodeId = `local-${randomUUID()}`;
    await writeFile(credentialFile, `${credential}\n`, { mode: 0o600 });
    await writeFile(identityFile, `${daemonNodeId}\n`, { mode: 0o600 });
    try {
      const [node] = await handle.db
        .insert(nodes)
        .values({ name: `local-${randomUUID()}`, kind: 'local', connectionStatus: 'connected' })
        .returning();
      const credentials = new NodeControlCredentials({
        db: handle.db,
        secrets: secretStore,
        localCredentialFile: credentialFile,
        localIdentityFile: identityFile,
      });
      await expect(credentials.forNode(node!.id, 'local')).resolves.toEqual({
        nodeId: daemonNodeId,
        credential,
      });

      await writeFile(credentialFile, `${'different-credential-value-at-least-32-bytes'}\n`);
      const reloaded = new NodeControlCredentials({
        db: handle.db,
        secrets: secretStore,
        localCredentialFile: credentialFile,
        localIdentityFile: identityFile,
      });
      await expect(reloaded.forNode(node!.id, 'local')).rejects.toThrow(/does not match/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
