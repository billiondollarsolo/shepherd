/**
 * US-21 — Async write-behind event log, integration (spec §6, §6.6; NFR-PERF1).
 *
 * Runs against the compose `postgres` service (DATABASE_URL), under
 * `pnpm test:int`. Proves end-to-end that:
 *   1. enqueued transitions land as real `events` rows (FIFO, append-only);
 *   2. wiring the queue into the in-memory StatusMap's `writeBehind` keeps the
 *      live fan-out SYNCHRONOUS and DB-free even when the DB write is slow (the
 *      NFR-PERF1 "artificially slow writer" proof at the integration level).
 *
 * Postgres is the system of record only — never the live status path (§6.6).
 */
import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '../db/client.js';
import type { DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentSessions, events, nodes, projects } from '../db/schema.js';
import { StatusMap } from '../status/map.js';

import { WriteBehindEventQueue } from './queue.js';
import { createDrizzleEventWriter } from './drizzle-event-writer.js';
import { ensureIntegrationOwner } from '../../test/integration-owner.js';

let handle: DbHandle;
let sessionId: string;

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);

  const { db } = handle;
  // Minimal node -> project -> session graph so the events FK resolves.
  const owner = await ensureIntegrationOwner(db, `evt-owner-${randomUUID().slice(0, 8)}`);
  const [node] = await db
    .insert(nodes)
    .values({ name: `n-${randomUUID().slice(0, 8)}`, kind: 'local', connectionStatus: 'connected' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ nodeId: node!.id, name: 'evt', workingDir: '/tmp' })
    .returning();
  const [session] = await db
    .insert(agentSessions)
    .values({
      nodeId: node!.id,
      projectId: project!.id,
      agentType: 'terminal',
      tmuxSessionName: `flock-evt-${randomUUID().slice(0, 8)}`,
      workingDir: '/tmp',
      hookTokenHash: `hash-evt-${randomUUID()}`,
      status: 'starting',
      createdBy: owner.id,
    })
    .returning();
  sessionId = session!.id;
});

afterAll(async () => {
  if (handle) await handle.pool.end();
});

describe('event log integration (§6 events, NFR-PERF1)', () => {
  it('writes enqueued transitions as real events rows in order', async () => {
    const { db } = handle;
    const queue = new WriteBehindEventQueue({ writer: createDrizzleEventWriter(db) });

    const sink = queue.transitionSink();
    sink(sessionId, 'running', null);
    sink(sessionId, 'awaiting_input', 'permission_prompt');
    sink(sessionId, 'done', null);

    await queue.flush();
    await queue.stop();

    const rows = await db
      .select()
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.seq));

    expect(rows.map((r) => r.status)).toEqual(['running', 'awaiting_input', 'done']);
    expect(rows.every((r) => r.source === 'orchestrator')).toBe(true);
    expect(rows.every((r) => r.type === 'status_transition')).toBe(true);
    // The append-only seq is monotonically increasing.
    for (let i = 1; i < rows.length; i += 1) {
      expect(Number(rows[i]!.seq)).toBeGreaterThan(Number(rows[i - 1]!.seq));
    }
  });

  it('a slow DB write does not delay the live status fan-out (NFR-PERF1)', async () => {
    const { db } = handle;
    // Wrap the real writer to add an artificial 200ms-per-row delay.
    const realWriter = createDrizzleEventWriter(db);
    const queue = new WriteBehindEventQueue({
      writer: async (r) => {
        await new Promise((res) => setTimeout(res, 200));
        await realWriter(r);
      },
    });

    const map = new StatusMap({ writeBehind: queue.transitionSink() });

    let fannedOut = false;
    map.subscribe(() => {
      fannedOut = true;
    });

    const start = performance.now();
    map.set(sessionId, 'idle');
    const elapsed = performance.now() - start;

    // Fan-out happened synchronously, far under the 200ms DB delay.
    expect(fannedOut).toBe(true);
    expect(elapsed).toBeLessThan(50);

    // The row still lands, eventually, off the live path.
    await queue.flush();
    await queue.stop();

    const idleRows = await db
      .select()
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.seq));
    expect(idleRows.some((r) => r.status === 'idle')).toBe(true);
  });
});
