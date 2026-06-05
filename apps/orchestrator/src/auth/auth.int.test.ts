/**
 * Flock — Auth flow INTEGRATION test (US-4/US-5/US-6, runs under `pnpm test:int`).
 *
 * Exercises the real Fastify auth routes against the compose `postgres` service
 * (DATABASE_URL), end to end:
 *   1. US-4  setup creates the first admin; a SECOND setup returns 409.
 *   2. US-5  login with good creds sets an httpOnly+Secure+SameSite cookie;
 *            bad creds -> 401; /api/auth/me requires a valid cookie (401 without).
 *   3. US-6  the admin invites a member via POST /api/users; the member can log
 *            in; the member is rejected (403) from the admin-only routes.
 *   4. US-5  logout revokes the session row; the cookie then fails /me with 401.
 *   5. FR-A3 login + user_create + logout audit rows are written.
 *
 * Postgres is the system of record only — never the live status path (§6.6).
 */
import { randomUUID } from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { auditLog, sessionsAuth, users } from '../db/schema.js';
import { buildServer } from '../server.js';
import { AuthService } from './service.js';
import { makeDbAuthAuditRecorder } from './audit-sink.js';
import { SESSION_COOKIE } from './cookie.js';

let handle: DbHandle;
let app: ReturnType<typeof buildServer>;

const suffix = randomUUID().slice(0, 8);
const ADMIN = { username: `admin-${suffix}`, password: 'admin-password-1' };
const MEMBER = { username: `member-${suffix}`, password: 'member-password-1' };
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
  // First-run setup is GLOBAL ("admin when none exists"); make it deterministic
  // by clearing the users table (test DB only) so this run's setup is genuinely
  // the first run. sessions_auth + user-owned audit rows cascade/clear with it.
  await handle.db.delete(sessionsAuth);
  await handle.db.delete(users);
  const auth = new AuthService({
    db: handle.db,
    audit: makeDbAuthAuditRecorder(handle.db),
  });
  app = buildServer({ auth });
  await app.ready();
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

describe('first-run status probe', () => {
  // Runs FIRST, before any setup: the DB was cleared in beforeAll, so the public
  // status endpoint must report that setup is still required. Non-mutating.
  it('GET /api/auth/status is public and reports setupRequired:true on a fresh DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().setupRequired).toBe(true);
  });
});

describe('US-4 first-run admin setup', () => {
  it('creates the initial admin (201) and stores an argon2id hash, not plaintext', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: ADMIN,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe(ADMIN.username);
    expect(body.user.role).toBe('admin');
    expect(JSON.stringify(body)).not.toContain('password');
    createdUserIds.push(body.user.id);

    const rows = await handle.db.select().from(users);
    const row = rows.find((r) => r.id === body.user.id);
    expect(row).toBeDefined();
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain(ADMIN.password);
  });

  it('returns 409 on a second setup once an admin exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: `other-${suffix}`, password: 'whatever-12' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('admin_exists');
  });

  it('GET /api/auth/status now reports setupRequired:false (admin exists)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().setupRequired).toBe(false);
  });
});

describe('US-5 login / session cookies / roles', () => {
  it('rejects bad credentials with 401 (no cookie set)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN.username, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logs in with good creds and sets an httpOnly+Secure+SameSite cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
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
      payload: ADMIN,
    });
    const cookie = cookieFromResponse(login.headers['set-cookie']);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe(ADMIN.username);
  });

  it('a malformed session cookie is 401, not a 500 (uuid parse must not leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'flock_session=not-a-valid-uuid' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });
});

describe('US-6 user invite (admin) + role enforcement', () => {
  async function adminCookie(): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
    });
    return cookieFromResponse(login.headers['set-cookie']);
  }

  it('an unauthenticated caller cannot create a user (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { ...MEMBER, role: 'member' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the admin invites a member (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: await adminCookie() },
      payload: { ...MEMBER, role: 'member' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe('member');
    createdUserIds.push(body.user.id);
  });

  it('the member can log in but is rejected (403) from admin-only routes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: MEMBER,
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFromResponse(login.headers['set-cookie']);

    const listUsers = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie },
    });
    expect(listUsers.statusCode).toBe(403);

    const createUser = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: `x-${suffix}`, password: 'password-123', role: 'member' },
    });
    expect(createUser.statusCode).toBe(403);

    // ...but the member CAN read their own identity.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('member');
  });
});

describe('US-5 logout revokes the session', () => {
  it('after logout the same cookie fails /api/auth/me with 401', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
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
  it('login, user_create, and logout actions were recorded', async () => {
    const rows = await handle.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.userId, createdUserIds));
    const actions = new Set(rows.map((r) => r.action));
    expect(actions.has('login')).toBe(true);
    expect(actions.has('user_create')).toBe(true);
    expect(actions.has('logout')).toBe(true);
  });
});
