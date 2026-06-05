/**
 * NodeService unit tests (FR-N1/N2/N3, FR-A3/A4) — `pnpm test:unit`.
 *
 * Uses a small in-memory fake DB (the subset of the drizzle query builder the
 * service calls) plus a real SecretStore over a fixed test keyring so the SSH
 * encryption-at-rest path is genuinely exercised — no real Postgres.
 */
import { describe, expect, it } from 'vitest';

import type { CreateNodeRequest } from '@flock/shared';

import { AuditLogger, type AuditSink } from '../audit/audit.js';
import { Keyring } from '../secrets/keyring.js';
import { SecretStore } from '../secrets/secret-store.js';
import { NodeService, NodeValidationError, DEFAULT_SSH_PORT } from './node-service.js';
import { nodes } from '../db/schema.js';

const USER_ID = '44444444-4444-4444-8444-444444444444';
// 32-byte key (64 hex) for the test keyring so encrypt() works without env.
const TEST_KEY = 'a'.repeat(64);

function makeSecretStore(audit?: AuditLogger): SecretStore {
  return new SecretStore({ keyring: new Keyring({ FLOCK_MASTER_KEY: TEST_KEY }), audit });
}

/**
 * Minimal fake of the drizzle handle for the service's `insert/select/delete`
 * chains. Stores rows in-memory and assigns ids; supports the exact call shapes
 * NodeService uses. Typed loosely (the methods return `any` builders) since the
 * real drizzle types are exercised by `typecheck` against the service, not here.
 */
class FakeDb {
  nodes: Record<string, unknown>[] = [];
  secrets: Record<string, unknown>[] = [];
  private seq = 0;

  private uuid(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: unknown): any {
    const store = table === nodes ? this.nodes : this.secrets;
    return {
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: this.uuid(), createdAt: new Date(), ...vals };
          store.push(row);
          return [row];
        },
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(_cols?: unknown): any {
    return {
      from: (table: unknown) => {
        const store = table === nodes ? this.nodes : this.secrets;
        // `await db.select().from(nodes)` resolves to all rows (listNodes);
        // `.where().limit()` resolves to the first match (ensureLocalNode).
        const thenable = Promise.resolve(store);
        return Object.assign(thenable, {
          where: () => ({ limit: async () => store.slice(0, 1) }),
        });
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(_table: unknown): any {
    return {
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const row = this.nodes[0];
            if (!row) return [];
            Object.assign(row, vals);
            return [row];
          },
        }),
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(_table: unknown): any {
    return {
      where: () => ({
        returning: async () => {
          const removed = this.nodes.shift();
          return removed ? [removed] : [];
        },
      }),
    };
  }
}

function makeService(
  sink?: AuditSink,
  hooks?: { onSshNodeUpdated?: (id: string) => void },
) {
  const audit = new AuditLogger(sink ?? { async write() {} });
  const db = new FakeDb();
  const store = makeSecretStore(audit);
  const service = new NodeService({
    db: db as never,
    secrets: store,
    audit,
    onSshNodeUpdated: hooks?.onSshNodeUpdated,
  });
  return { service, db, store };
}

/** Decrypt a stored secret row (nonce||authTag envelope) back to its plaintext. */
async function decryptSecret(store: SecretStore, row: Record<string, unknown>): Promise<string> {
  const nonceBytes = new Uint8Array(row.nonce as Buffer);
  return store.decryptToString(
    {
      ciphertext: new Uint8Array(row.ciphertext as Buffer),
      nonce: nonceBytes.slice(0, 12),
      authTag: nonceBytes.slice(12),
      keyVersion: row.keyVersion as number,
    },
    { secretId: row.id as string },
  );
}

describe('NodeService.createNode', () => {
  it('persists a local node as connected with no ssh fields and audits node_add', async () => {
    const writes: unknown[] = [];
    const { service, db } = makeService({ async write(e) { writes.push(e); } });

    const node = await service.createNode(
      { name: 'local', kind: 'local' } satisfies CreateNodeRequest,
      { userId: USER_ID, ip: '1.2.3.4' },
    );

    expect(node.kind).toBe('local');
    expect(node.connectionStatus).toBe('connected');
    expect(node.host).toBeNull();
    expect(node.sshKeyRef).toBeNull();
    expect(db.secrets).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect((writes[0] as { action: string }).action).toBe('node_add');
  });

  it('encrypts the ssh private key at rest, stores only the secret id, never the raw key', async () => {
    const { service, db } = makeService();
    const RAW_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-bytes\n-----END-----';

    const node = await service.createNode(
      {
        name: 'edge',
        kind: 'ssh',
        host: 'edge.example.com',
        sshUser: 'flock',
        sshPrivateKey: RAW_KEY,
      } satisfies CreateNodeRequest,
      { userId: USER_ID },
    );

    // The node references a secret, defaults the port, and is disconnected.
    expect(node.kind).toBe('ssh');
    expect(node.connectionStatus).toBe('disconnected');
    expect(node.port).toBe(DEFAULT_SSH_PORT);
    expect(node.sshUser).toBe('flock');
    expect(node.sshKeyRef).toBeTruthy();

    // Exactly one secret row was written, as CIPHERTEXT — never the plaintext.
    expect(db.secrets).toHaveLength(1);
    const secret = db.secrets[0]!;
    expect(secret.kind).toBe('ssh_key');
    const ciphertext = secret.ciphertext as Buffer;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.toString('utf8')).not.toContain('secret-bytes');

    // The node row itself stores no key material, only the opaque ref.
    const nodeRow = db.nodes[0]! as Record<string, unknown>;
    expect(JSON.stringify(nodeRow)).not.toContain('secret-bytes');
    expect(nodeRow.sshKeyRef).toBe(secret.id);
  });

  it('stores a password credential (encrypted) for password auth, never the raw password', async () => {
    const { service, db, store } = makeService();
    const node = await service.createNode(
      {
        name: 'pw-box',
        kind: 'ssh',
        host: 'h',
        sshUser: 'u',
        sshAuthMethod: 'password',
        sshPassword: 'hunter2-secret',
      } satisfies CreateNodeRequest,
      { userId: USER_ID },
    );
    expect(node.sshAuthMethod).toBe('password');
    expect(node.sshKeyRef).toBeTruthy();
    expect(db.secrets).toHaveLength(1);
    // Ciphertext never contains the raw password; decrypting yields the bundle.
    expect((db.secrets[0]!.ciphertext as Buffer).toString('utf8')).not.toContain('hunter2-secret');
    const cred = JSON.parse(await decryptSecret(store, db.secrets[0]!)) as { password?: string };
    expect(cred.password).toBe('hunter2-secret');
  });

  it('honors an explicit ssh port override', async () => {
    const { service } = makeService();
    const node = await service.createNode(
      {
        name: 'edge',
        kind: 'ssh',
        host: 'h',
        port: 2222,
        sshUser: 'u',
        sshPrivateKey: 'k',
      } satisfies CreateNodeRequest,
      { userId: USER_ID },
    );
    expect(node.port).toBe(2222);
  });
});

describe('NodeService.updateNode', () => {
  const SSH_CREATE: CreateNodeRequest = {
    name: 'edge',
    kind: 'ssh',
    host: 'edge.example.com',
    sshUser: 'flock',
    sshPrivateKey: '-----BEGIN KEY-----\noriginal\n-----END-----',
  };

  it('renames a node, audits node_update, and returns the updated node', async () => {
    const writes: unknown[] = [];
    const { service } = makeService({ async write(e) { writes.push(e); } });
    const created = await service.createNode(SSH_CREATE, { userId: USER_ID });
    writes.length = 0;

    const updated = await service.updateNode(created.id, { name: 'renamed' }, { userId: USER_ID });
    expect(updated?.name).toBe('renamed');
    expect((writes[0] as { action: string }).action).toBe('node_update');
  });

  it('rotating only the passphrase keeps the existing private key (decrypt-merge-reencrypt)', async () => {
    const { service, db, store } = makeService();
    const created = await service.createNode(SSH_CREATE, { userId: USER_ID });

    await service.updateNode(created.id, { sshPassphrase: 'new-pass' }, { userId: USER_ID });

    // A second secret was written; it bundles the ORIGINAL key + the new passphrase.
    expect(db.secrets).toHaveLength(2);
    const cred = JSON.parse(await decryptSecret(store, db.secrets[1]!)) as {
      privateKey?: string;
      passphrase?: string;
    };
    expect(cred.privateKey).toContain('original');
    expect(cred.passphrase).toBe('new-pass');
  });

  it('throws NodeValidationError when switching to password auth with no password', async () => {
    const { service } = makeService();
    const created = await service.createNode(SSH_CREATE, { userId: USER_ID });
    await expect(
      service.updateNode(created.id, { sshAuthMethod: 'password' }, { userId: USER_ID }),
    ).rejects.toBeInstanceOf(NodeValidationError);
  });

  it('fires onSshNodeUpdated when connection params change', async () => {
    const reconnected: string[] = [];
    const { service } = makeService(undefined, { onSshNodeUpdated: (id) => reconnected.push(id) });
    const created = await service.createNode(SSH_CREATE, { userId: USER_ID });

    await service.updateNode(created.id, { host: 'moved.example.com' }, { userId: USER_ID });
    expect(reconnected).toEqual([created.id]);
  });

  it('does NOT fire onSshNodeUpdated for a name-only edit', async () => {
    const reconnected: string[] = [];
    const { service } = makeService(undefined, { onSshNodeUpdated: (id) => reconnected.push(id) });
    const created = await service.createNode(SSH_CREATE, { userId: USER_ID });

    await service.updateNode(created.id, { name: 'just-a-rename' }, { userId: USER_ID });
    expect(reconnected).toEqual([]);
  });

  it('returns null for an unknown node id', async () => {
    const { service } = makeService();
    const result = await service.updateNode('missing', { name: 'x' }, { userId: USER_ID });
    expect(result).toBeNull();
  });
});

describe('NodeService.deleteNode', () => {
  it('removes a node and audits node_remove', async () => {
    const writes: unknown[] = [];
    const { service } = makeService({ async write(e) { writes.push(e); } });
    await service.createNode({ name: 'local', kind: 'local' }, { userId: USER_ID });
    writes.length = 0;

    const removed = await service.deleteNode('any-id', { userId: USER_ID });
    expect(removed).toBe(true);
    expect((writes[0] as { action: string }).action).toBe('node_remove');
  });

  it('returns false (no audit) for an unknown node', async () => {
    const writes: unknown[] = [];
    const { service } = makeService({ async write(e) { writes.push(e); } });
    const removed = await service.deleteNode('missing', { userId: USER_ID });
    expect(removed).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('NodeService.ensureLocalNode (boot seeding idempotency)', () => {
  it('creates a local node when none exists', async () => {
    const { service, db } = makeService();
    const node = await service.ensureLocalNode();
    expect(node.kind).toBe('local');
    expect(node.connectionStatus).toBe('connected');
    expect(db.nodes).toHaveLength(1);
  });

  it('is idempotent: returns the existing local node without creating another', async () => {
    const { service, db } = makeService();
    const first = await service.ensureLocalNode();
    const second = await service.ensureLocalNode();
    expect(db.nodes).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });
});
