/**
 * REST CRUD INTEGRATION test (FR-N1/N2/N3, FR-S2/S3) — `pnpm test:int`.
 *
 * Runs inside the docker dev container against the REAL compose `postgres`
 * service. Exercises the concrete db-backed services end-to-end:
 *   create node → create project → create session, then list each back.
 *
 * Proves the persisted path the paddock relies on: a node/project/session
 * created via the services is readable via the list APIs, the ssh key is stored
 * as a secret reference (never plaintext), and boot seeding is idempotent.
 *
 * Postgres is the system of record here, never the live status path (spec §6.6).
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogger } from './audit/audit.js';
import { createDb } from './db/client.js';
import type { DbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { nodes, secrets, users } from './db/schema.js';
import { Keyring } from './secrets/keyring.js';
import { SecretStore } from './secrets/secret-store.js';
import { NodeService } from './nodes/node-service.js';
import { ProjectService } from './projects/project-service.js';
import { SessionRestService } from './sessions/session-rest-service.js';

let handle: DbHandle;
let nodeService: NodeService;
let projectService: ProjectService;
let sessionService: SessionRestService;

const TEST_KEY = 'b'.repeat(64); // 32-byte key as 64 hex chars
// Real acting-user id; nodes.created_by FKs into users (spec §6), so it must
// reference an existing row. Seeded in beforeAll.
let ACTOR: string;

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  const [actor] = await handle.db
    .insert(users)
    .values({
      username: `crud-actor-${randomUUID().slice(0, 8)}`,
      passwordHash: 'argon2id$placeholder',
      role: 'admin',
    })
    .returning();
  ACTOR = actor!.id;
  const audit = new AuditLogger({ async write() {} });
  const secretStore = new SecretStore({
    keyring: new Keyring({ FLOCK_MASTER_KEY: TEST_KEY }),
    audit,
  });
  nodeService = new NodeService({ db: handle.db, secrets: secretStore, audit });
  projectService = new ProjectService({ db: handle.db });
  // No localTmux here: persistence + listing is the requirement; we do not need
  // a real tmux session for the CRUD round-trip.
  sessionService = new SessionRestService({
    db: handle.db,
    hashToken: async (t) => `argon2id$test$${t.slice(0, 8)}`,
    audit,
  });
}, 30_000);

afterAll(async () => {
  if (handle) await handle.pool.end();
});

describe('CRUD integration — node → project → session round-trip', () => {
  it('creates a local node, persists it, and lists it back', async () => {
    const created = await nodeService.createNode(
      { name: `local-${randomUUID().slice(0, 8)}`, kind: 'local' },
      { userId: ACTOR },
    );
    expect(created.kind).toBe('local');
    expect(created.connectionStatus).toBe('connected');

    const list = await nodeService.listNodes();
    expect(list.map((n) => n.id)).toContain(created.id);
  });

  it('encrypts an ssh node key at rest (secret ref, never plaintext)', async () => {
    const RAW = '-----BEGIN KEY-----\nint-secret-material\n-----END KEY-----';
    const node = await nodeService.createNode(
      {
        name: `edge-${randomUUID().slice(0, 8)}`,
        kind: 'ssh',
        host: 'edge.example.com',
        sshUser: 'flock',
        sshPrivateKey: RAW,
      },
      { userId: ACTOR },
    );
    expect(node.connectionStatus).toBe('disconnected');
    expect(node.port).toBe(22);
    expect(node.sshKeyRef).toBeTruthy();

    // The secret row holds ciphertext only — the raw key is not present.
    const [secretRow] = await handle.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, node.sshKeyRef!));
    expect(secretRow).toBeDefined();
    expect(Buffer.from(secretRow!.ciphertext).toString('utf8')).not.toContain('int-secret-material');
  });

  it('creates a project on the node and lists it (optionally filtered)', async () => {
    const node = await nodeService.createNode(
      { name: `n-${randomUUID().slice(0, 8)}`, kind: 'local' },
      { userId: ACTOR },
    );
    const project = await projectService.createProject({
      nodeId: node.id,
      name: 'flock',
      workingDir: '/work/flock',
    });
    expect(project.nodeId).toBe(node.id);

    const filtered = await projectService.listProjects(node.id);
    expect(filtered.map((p) => p.id)).toEqual([project.id]);
  });

  it('rejects a project on an unknown node', async () => {
    await expect(
      projectService.createProject({
        nodeId: randomUUID(),
        name: 'x',
        workingDir: '/x',
      }),
    ).rejects.toThrow();
  });

  it('creates a session for the project and lists it back (one authoritative record)', async () => {
    const node = await nodeService.createNode(
      { name: `n-${randomUUID().slice(0, 8)}`, kind: 'local' },
      { userId: ACTOR },
    );
    const project = await projectService.createProject({
      nodeId: node.id,
      name: 'p',
      workingDir: '/work/p',
    });

    const { session, hookToken } = await sessionService.createSession(
      { projectId: project.id, agentType: 'claude-code' },
      { userId: ACTOR },
    );
    expect(hookToken).toBeTruthy();
    expect(session.workingDir).toBe('/work/p');
    expect(session.tmuxSessionName).toContain(session.id);
    expect(session.hookTokenHash).not.toBe(hookToken);

    const list = await sessionService.listSessions(project.id);
    expect(list.map((s) => s.id)).toEqual([session.id]);
  });
});

describe('CRUD integration — boot seeding idempotency', () => {
  it('ensureLocalNode never creates a duplicate local node on repeat', async () => {
    const first = await nodeService.ensureLocalNode();
    const second = await nodeService.ensureLocalNode();
    expect(second.id).toBe(first.id);

    const locals = await handle.db.select().from(nodes).where(eq(nodes.kind, 'local'));
    // At least one local node exists; ensureLocalNode returned the SAME one twice
    // rather than adding a new row each call.
    expect(locals.some((n) => n.id === first.id)).toBe(true);
  });
});
