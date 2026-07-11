/**
 * US-40 — Audit log surface INTEGRATION test (runs under `pnpm test:int`).
 *
 * Exercises the owner audit READ surface end to end against the compose
 * `postgres` service (DATABASE_URL), proving FR-A3's two halves together:
 *   1. WRITE  — the audited actions land as rows in `audit_log`: this test
 *               writes them through the SAME seam production uses (the Drizzle
 *               `AuditSink` for the AuditLogger). (login is also covered live by
 *               auth.int.test.ts; here we assert the action kinds are
 *               readable through the owner endpoint.)
 *   2. READ   — `GET /api/audit` returns the rows for the owner (200), rejects
 *               an unauthenticated caller (401), and
 *               its action filter narrows the result.
 *
 * Postgres is the durable system of record only — never the live status path
 * (§6.6). The audit read is intentionally off the hot path.
 */
import { randomUUID } from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogger, AuditQueryService, DrizzleAuditReadStore } from './index.js';
import {
  AuthService,
  SESSION_COOKIE,
  makeDbAuditSink,
  makeDbAuthAuditRecorder,
} from '../auth/index.js';
import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentSessions, auditLog, sessionsAuth, users } from '../db/schema.js';
import { buildServer } from '../server.js';

let handle: DbHandle;
let app: ReturnType<typeof buildServer>;

const suffix = randomUUID().slice(0, 8);
const OWNER = { username: `audit-owner-${suffix}`, password: 'owner-password-1' };
const createdUserIds: string[] = [];
let ownerId = '';

/** Pull the session id out of a Set-Cookie response header. */
function cookieFromResponse(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  return `${SESSION_COOKIE}=${m ? m[1] : ''}`;
}

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  // Deterministic first-run setup (test DB only).
  await handle.db.delete(agentSessions);
  await handle.db.delete(sessionsAuth);
  await handle.db.delete(users);

  const auth = new AuthService({
    db: handle.db,
    audit: makeDbAuthAuditRecorder(handle.db),
  });
  const auditQuery = new AuditQueryService(new DrizzleAuditReadStore(handle.db));
  app = buildServer({ auth, audit: auditQuery });
  await app.ready();

  // Create the installation owner through the real setup route.
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  ownerId = setup.json().user.id;
  createdUserIds.push(ownerId);

  // Write one row of EACH remaining audited action through the production seam
  // (the Drizzle AuditSink), attributed to the owner so cleanup can find them.
  const logger = new AuditLogger(makeDbAuditSink(handle.db));
  await logger.recordNodeAdd({ nodeId: randomUUID(), userId: ownerId });
  await logger.recordNodeRemove({ nodeId: randomUUID(), userId: ownerId });
  await logger.record({
    action: 'node_control_event',
    userId: ownerId,
    targetType: 'node',
    targetId: randomUUID(),
    detail: { event: 'connected' },
  });
  await logger.recordSessionCreate({ sessionId: randomUUID(), userId: ownerId });
  await logger.record({
    action: 'session_terminate',
    userId: ownerId,
    targetType: 'session',
    targetId: randomUUID(),
  });
  await logger.record({
    action: 'browser_takeover',
    userId: ownerId,
    targetType: 'session',
    targetId: randomUUID(),
  });
  await logger.recordSecretAccess({ secretId: randomUUID(), userId: ownerId, keyVersion: 1 });
});

afterAll(async () => {
  await app.close();
  if (createdUserIds.length > 0) {
    await handle.db.delete(sessionsAuth).where(inArray(sessionsAuth.userId, createdUserIds));
    await handle.db.delete(auditLog).where(inArray(auditLog.userId, createdUserIds));
    await handle.db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await handle.pool.end();
});

async function ownerCookie(): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
  return cookieFromResponse(login.headers['set-cookie']);
}

describe('GET /api/audit — owner read (US-40, FR-A3)', () => {
  it('rejects an unauthenticated read with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the audit rows for the owner, newest-first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?userId=${ownerId}&limit=500`,
      headers: { cookie: await ownerCookie() },
    });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<{ action: string; ts: string }> };
    const actions = new Set(entries.map((e) => e.action));

    // Security-relevant actions are present and readable by the owner.
    for (const a of [
      'login',
      'node_add',
      'node_remove',
      'node_control_event',
      'session_create',
      'session_terminate',
      'browser_takeover',
      'secret_access',
    ]) {
      expect(actions.has(a)).toBe(true);
    }

    // Newest-first ordering (descending ts).
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1]!.ts >= entries[i]!.ts).toBe(true);
    }
  });

  it('narrows by action filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?action=node_add&userId=${ownerId}`,
      headers: { cookie: await ownerCookie() },
    });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<{ action: string }> };
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === 'node_add')).toBe(true);
  });
});
