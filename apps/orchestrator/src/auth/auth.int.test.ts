/**
 * Shepherd — single-owner auth flow integration test (US-4/US-5).
 *
 * Exercises the real Fastify auth routes against the compose `postgres` service
 * (DATABASE_URL), end to end:
 *   1. US-4  setup creates the installation owner; a SECOND setup returns 409.
 *   2. US-5  login with good creds sets an httpOnly+Secure+SameSite cookie;
 *            bad creds -> 401; /api/auth/me requires a valid cookie (401 without).
 *   3. The database enforces exactly one owner even if route checks race.
 *   4. US-5  logout revokes the session row; the cookie then fails /me with 401.
 *   5. FR-A3 owner_setup + login + logout audit rows are written.
 *
 * Postgres is the system of record only — never the live status path (§6.6).
 */
import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  agentSessions,
  auditLog,
  authLoginThrottle,
  nodes,
  sessionsAuth,
  users,
} from '../db/schema.js';
import { buildServer } from '../server.js';
import { AuthService } from './service.js';
import { makeDbAuthAuditRecorder } from './audit-sink.js';
import { SESSION_COOKIE } from './cookie.js';
import { PersistentLoginThrottle } from './persistent-login-throttle.js';

let handle: DbHandle;
let app: ReturnType<typeof buildServer>;

const suffix = randomUUID().slice(0, 8);
const OWNER = { username: `owner-${suffix}`, password: 'owner-password-1' };
const SETUP_TOKEN = 'release-style-bootstrap-token-0123456789abcdef';
const createdUserIds: string[] = [];

/** Pull the session id out of a Set-Cookie response header. */
function cookieFromResponse(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  return `${SESSION_COOKIE}=${m ? m[1] : ''}`;
}

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  // First-run setup is global; make it deterministic
  // by clearing the users table (test DB only) so this run's setup is genuinely
  // the first run. Sessions must be removed first because production ownership
  // intentionally uses ON DELETE RESTRICT.
  await handle.db.delete(agentSessions);
  await handle.db.delete(sessionsAuth);
  await handle.db.delete(authLoginThrottle);
  await handle.db.delete(users);
  // Mirror main()'s boot order: the orchestrator seeds its stable local node
  // before first-run owner setup, then AuthService claims that pre-owner row.
  // A genuinely empty test database has no prior run from which to inherit it.
  const localNodes = await handle.db.select().from(nodes).where(eq(nodes.kind, 'local')).limit(1);
  if (localNodes.length === 0) {
    await handle.db
      .insert(nodes)
      .values({ name: 'local', kind: 'local', connectionStatus: 'connected' });
  }
  const auth = new AuthService({
    db: handle.db,
    audit: makeDbAuthAuditRecorder(handle.db),
    setupToken: SETUP_TOKEN,
  });
  app = buildServer({ auth, loginThrottle: new PersistentLoginThrottle(handle.db) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (createdUserIds.length > 0) {
    await handle.db.delete(sessionsAuth).where(inArray(sessionsAuth.userId, createdUserIds));
    await handle.db.delete(auditLog).where(inArray(auditLog.userId, createdUserIds));
    await handle.db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await handle.db.delete(authLoginThrottle);
  await handle.pool.end();
});

describe('first-run status probe', () => {
  // Runs FIRST, before any setup: the DB was cleared in beforeAll, so the public
  // status endpoint must report that setup is still required. Non-mutating.
  it('GET /api/auth/status is public and reports setupRequired:true on a fresh DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().setupRequired).toBe(true);
    expect(res.json().setupTokenRequired).toBe(true);
    expect(res.json().deployment).toEqual({
      mode: 'development',
      transport: 'https',
      warning: null,
    });
  });
});

describe('US-4 first-run owner setup', () => {
  it('rejects setup without the out-of-band bootstrap token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: OWNER,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_setup_token');
  });

  it('creates the installation owner (201) and stores an argon2id hash, not plaintext', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { ...OWNER, setupToken: SETUP_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe(OWNER.username);
    expect(body.user).not.toHaveProperty('role');
    expect(JSON.stringify(body)).not.toContain('password');
    expect(JSON.stringify(body)).not.toContain(SETUP_TOKEN);
    createdUserIds.push(body.user.id);

    const rows = await handle.db.select().from(users);
    const row = rows.find((r) => r.id === body.user.id);
    expect(row).toBeDefined();
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain(OWNER.password);

    const nodeRows = await handle.db.select({ createdBy: nodes.createdBy }).from(nodes);
    expect(nodeRows.length).toBeGreaterThan(0);
    expect(nodeRows.every((node) => node.createdBy === body.user.id)).toBe(true);
  });

  it('returns 409 on a second setup once the owner exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: `other-${suffix}`, password: 'whatever-123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('owner_exists');
  });

  it('GET /api/auth/status now reports setupRequired:false (owner exists)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().setupRequired).toBe(false);
    expect(res.json().setupTokenRequired).toBe(false);
  });
});

describe('US-5 login / session cookies', () => {
  it('rejects bad credentials with 401 (no cookie set)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: OWNER.username, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logs in with good creds and sets an httpOnly+Secure+SameSite cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it('GET /api/auth/me is 401 without a cookie and 200 with a valid one', async () => {
    const noCookie = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(noCookie.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const cookie = cookieFromResponse(login.headers['set-cookie']);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe(OWNER.username);
  });

  it('a malformed session cookie is 401, not a 500 (uuid parse must not leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=not-a-valid-uuid` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });
});

describe('single-owner database invariant', () => {
  it('rejects a second user row independently of route-level setup checks', async () => {
    await expect(
      handle.db.insert(users).values({
        username: `second-owner-${suffix}`,
        passwordHash: 'argon2id$fixture',
      }),
    ).rejects.toThrow();

    const rows = await handle.db.select({ id: users.id }).from(users);
    expect(rows).toHaveLength(1);
  });
});

describe('US-5 logout revokes the session', () => {
  it('after logout the same cookie fails /api/auth/me with 401', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const cookie = cookieFromResponse(login.headers['set-cookie']);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe('FR-A3 audit rows', () => {
  it('owner_setup, login, and logout actions were recorded', async () => {
    const rows = await handle.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.userId, createdUserIds));
    const actions = new Set(rows.map((r) => r.action));
    expect(actions.has('login')).toBe(true);
    expect(actions.has('owner_setup')).toBe(true);
    expect(actions.has('logout')).toBe(true);
  });
});

describe('durable public-login hardening', () => {
  it('retains a lockout across throttle instances (process restarts)', async () => {
    const key = PersistentLoginThrottle.key('203.0.113.10', `probe-${suffix}`);
    const first = new PersistentLoginThrottle(handle.db, { maxFailures: 1, lockoutMs: 60_000 });
    await first.recordFailure(key);

    const afterRestart = new PersistentLoginThrottle(handle.db, {
      maxFailures: 1,
      lockoutMs: 60_000,
    });
    expect(await afterRestart.check(key)).toMatchObject({ allowed: false });
    await handle.db.delete(authLoginThrottle).where(eq(authLoginThrottle.keyHash, key));
  });

  it('keeps the current login but revokes every other session after a password change', async () => {
    const firstLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const firstCookie = cookieFromResponse(firstLogin.headers['set-cookie']);
    const secondCookie = cookieFromResponse(secondLogin.headers['set-cookie']);
    const nextPassword = 'replacement-owner-password-2';

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: firstCookie },
      payload: { currentPassword: OWNER.password, newPassword: nextPassword },
    });
    expect(changed.statusCode).toBe(204);

    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: secondCookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: OWNER.username, password: nextPassword },
        })
      ).statusCode,
    ).toBe(200);
  });
});
