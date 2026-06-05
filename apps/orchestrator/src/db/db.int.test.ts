/**
 * Flock — US-2 data-model INTEGRATION test (spec §6, runs under `pnpm test:int`).
 *
 * Runs against the compose `postgres` service (DATABASE_URL). It:
 *   1. runs migrations idempotently (twice — proving `pnpm migrate` is idempotent);
 *   2. inserts a user -> node -> project -> agent_session chain and reads it back;
 *   3. ASSERTS the single authoritative session record invariant (spec §4.2): the
 *      session_id (agent_sessions.id) threads the tmux session name, the hook
 *      token hash, and the browser CDP endpoint in ONE row;
 *   4. asserts hook_token_hash uniqueness (per-session token cannot collide);
 *   5. asserts the events log accepts append-only writes ordered by (session_id, seq).
 *
 * Postgres is the system of record only — never the live status path (§6.6).
 */
import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import type { DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { rowToSession } from './mappers.js';
import { agentSessions, events, nodes, projects, users } from './schema.js';

let handle: DbHandle;

beforeAll(async () => {
  handle = createDb();
  // Idempotent: applying twice must not error (US-2 acceptance: idempotent migrate).
  await runMigrations(handle);
  await runMigrations(handle);
});

afterAll(async () => {
  if (handle) {
    await handle.pool.end();
  }
});

async function seedChain(): Promise<{
  nodeId: string;
  projectId: string;
}> {
  const { db } = handle;
  const [admin] = await db
    .insert(users)
    .values({
      username: `admin-${randomUUID().slice(0, 8)}`,
      passwordHash: 'argon2id$placeholder',
      role: 'admin',
    })
    .returning();
  const [node] = await db
    .insert(nodes)
    .values({
      name: `node-${randomUUID().slice(0, 8)}`,
      kind: 'ssh',
      host: '10.0.0.5',
      port: 22,
      sshUser: 'flock',
      connectionStatus: 'connected',
      createdBy: admin!.id,
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      nodeId: node!.id,
      name: 'demo',
      workingDir: '/home/flock/work/demo',
    })
    .returning();
  return { nodeId: node!.id, projectId: project!.id };
}

describe('US-2 integration — node -> project -> agent_session chain', () => {
  it('inserts the chain and reads back the single authoritative session record', async () => {
    const { db } = handle;
    const { nodeId, projectId } = await seedChain();

    const tmuxSessionName = `flock-${randomUUID().slice(0, 8)}`;
    const hookTokenHash = `argon2id$${randomUUID()}`;
    const browserCdpEndpoint = `ws://127.0.0.1:9222/devtools/browser/${randomUUID()}`;

    const [inserted] = await db
      .insert(agentSessions)
      .values({
        nodeId,
        projectId,
        agentType: 'claude-code',
        tmuxSessionName,
        workingDir: '/home/flock/work/demo',
        browserCdpEndpoint,
        hookTokenHash,
        status: 'running',
      })
      .returning();

    // Read it back independently.
    const [readBack] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, inserted!.id));

    expect(readBack).toBeDefined();

    // ---- THE INVARIANT (single authoritative session record, §4.2) ----
    // One session_id (the row id) threads tmux name + hook token hash + CDP endpoint.
    const session = rowToSession(readBack!);
    expect(session.id).toBe(inserted!.id);
    expect(session.tmuxSessionName).toBe(tmuxSessionName);
    expect(session.hookTokenHash).toBe(hookTokenHash);
    expect(session.browserCdpEndpoint).toBe(browserCdpEndpoint);
    // All three identities live in ONE row keyed by the single session_id.
    expect(readBack!.tmuxSessionName).toBe(tmuxSessionName);
    expect(readBack!.hookTokenHash).toBe(hookTokenHash);
    expect(readBack!.browserCdpEndpoint).toBe(browserCdpEndpoint);
  });

  it('enforces hook_token_hash uniqueness (per-session token cannot collide)', async () => {
    const { db } = handle;
    const { nodeId, projectId } = await seedChain();

    const dupHash = `argon2id$${randomUUID()}`;
    await db.insert(agentSessions).values({
      nodeId,
      projectId,
      agentType: 'codex',
      tmuxSessionName: `t-${randomUUID().slice(0, 8)}`,
      workingDir: '/w',
      hookTokenHash: dupHash,
      status: 'idle',
    });

    await expect(
      db.insert(agentSessions).values({
        nodeId,
        projectId,
        agentType: 'codex',
        tmuxSessionName: `t-${randomUUID().slice(0, 8)}`,
        workingDir: '/w',
        hookTokenHash: dupHash,
        status: 'idle',
      }),
    ).rejects.toThrow();
  });

  it('accepts append-only event writes ordered by (session_id, seq)', async () => {
    const { db } = handle;
    const { nodeId, projectId } = await seedChain();

    const [session] = await db
      .insert(agentSessions)
      .values({
        nodeId,
        projectId,
        agentType: 'opencode',
        tmuxSessionName: `t-${randomUUID().slice(0, 8)}`,
        workingDir: '/w',
        hookTokenHash: `argon2id$${randomUUID()}`,
        status: 'running',
      })
      .returning();

    const types = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
    for (const [i, type] of types.entries()) {
      await db.insert(events).values({
        sessionId: session!.id,
        type,
        source: 'hook',
        agentEventRaw: { i },
        status: i === types.length - 1 ? 'done' : 'running',
      });
    }

    const rows = await db
      .select()
      .from(events)
      .where(eq(events.sessionId, session!.id))
      .orderBy(asc(events.seq));

    expect(rows).toHaveLength(types.length);
    expect(rows.map((r) => r.type)).toEqual(types);
    // seq is monotonically increasing (append-only ordering guarantee).
    for (let i = 1; i < rows.length; i += 1) {
      expect(Number(rows[i]!.seq)).toBeGreaterThan(Number(rows[i - 1]!.seq));
    }
  });
});
