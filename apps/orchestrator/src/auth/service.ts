/**
 * Auth service (US-4/US-5/US-6, FR-A1/A2/A3).
 *
 * Pure-ish data layer between the HTTP routes and Postgres. Owns:
 *   - first-run admin creation (409 once any admin exists)         [US-4]
 *   - credential validation + login-session issuance               [US-5]
 *   - session-cookie validation (load the acting user)             [US-5]
 *   - logout (revoke the sessions_auth row)                        [US-5]
 *   - user invite/create (admin only, enforced at the route)      [US-6]
 *
 * Postgres here is the durable system of record (spec §6); auth is NOT on the
 * live status path so synchronous DB use is correct. Every security-relevant
 * action writes an append-only `audit_log` row through {@link AuditLogger}
 * (FR-A3): `login`, `logout`, `user_create`. The `secret_access` audit row is
 * written by the SecretStore on decrypt (US-3); this service writes a
 * `secret_access` row when it reads the stored credential material to verify a
 * login, so credential reads are auditable too.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';

/**
 * Session ids are UUIDs (the cookie carries one verbatim). A malformed cookie
 * (truncated, tampered, or from an old format) must NOT reach the `uuid` column
 * — Postgres would raise `22P02 invalid input syntax for type uuid` and surface
 * as a 500. We pre-validate so a bad cookie resolves to "no session" → 401.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import type { AuditAction, Role, User } from '@flock/shared';
import type { Database } from '../db/client.js';
import { sessionsAuth, users, type UserRow } from '../db/schema.js';
import { hashPassword, verifyPassword } from './hashing.js';

/**
 * Minimal audit recorder the auth service writes through (FR-A3). Typed with the
 * SHARED `AuditAction` (which includes `user_create`/`logout`) so this module is
 * decoupled from the orchestrator audit module's narrower local union. The
 * concrete {@link AuthAuditEntry} maps 1:1 onto the `audit_log` columns.
 */
export interface AuthAuditEntry {
  action: AuditAction;
  userId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuthAuditRecorder {
  record(entry: AuthAuditEntry): Promise<void>;
}

/** How long a login session lives before it must be re-established. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Raised when first-run setup is attempted but an admin already exists (409). */
export class AdminAlreadyExistsError extends Error {
  constructor() {
    super('An admin account already exists; setup is closed.');
    this.name = 'AdminAlreadyExistsError';
  }
}

/** Raised when a username is already taken (409). */
export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken.`);
    this.name = 'UsernameTakenError';
  }
}

/** Raised when login credentials do not validate (401). */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid username or password.');
    this.name = 'InvalidCredentialsError';
  }
}

/** Context carried with audited actions (network origin). */
export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** Map a DB user row to the public, serializable shared `User` (no hash). */
export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? null,
    role: row.role as Role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    isActive: row.isActive,
  };
}

export interface AuthServiceDeps {
  db: Database;
  audit: AuthAuditRecorder;
}

export class AuthService {
  private readonly db: Database;
  private readonly audit: AuthAuditRecorder;

  constructor(deps: AuthServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
  }

  /** True once at least one admin account exists (gates first-run setup). */
  async adminExists(): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * US-4: create the initial admin. Throws {@link AdminAlreadyExistsError}
   * (→ 409) if any admin already exists. Stores an argon2id hash only.
   */
  async setupInitialAdmin(
    input: { username: string; password: string },
    ctx: RequestContext = {},
  ): Promise<User> {
    if (await this.adminExists()) {
      throw new AdminAlreadyExistsError();
    }
    const passwordHash = await hashPassword(input.password);
    let row: UserRow;
    try {
      const [inserted] = await this.db
        .insert(users)
        .values({ username: input.username, passwordHash, role: 'admin' })
        .returning();
      row = inserted!;
    } catch {
      // Unique-violation on username (race or duplicate setup attempt).
      throw new UsernameTakenError(input.username);
    }
    await this.audit.record({
      action: 'user_create',
      userId: row.id,
      targetType: 'user',
      targetId: row.id,
      ip: ctx.ip ?? null,
      detail: { role: 'admin', firstRun: true },
    });
    return rowToUser(row);
  }

  /**
   * US-6: create a user (admin invites a member/admin). The route enforces the
   * admin-only guard; this method records `user_create` attributed to the
   * acting admin. Throws {@link UsernameTakenError} (→ 409) on collision.
   */
  async createUser(
    input: { username: string; password: string; role: Role },
    actor: { id: string },
    ctx: RequestContext = {},
  ): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    let row: UserRow;
    try {
      const [inserted] = await this.db
        .insert(users)
        .values({ username: input.username, passwordHash, role: input.role })
        .returning();
      row = inserted!;
    } catch {
      throw new UsernameTakenError(input.username);
    }
    await this.audit.record({
      action: 'user_create',
      userId: actor.id,
      targetType: 'user',
      targetId: row.id,
      ip: ctx.ip ?? null,
      detail: { role: input.role },
    });
    return rowToUser(row);
  }

  /** List all users (admin route). Never includes password hashes. */
  async listUsers(): Promise<User[]> {
    const rows = await this.db.select().from(users);
    return rows.map(rowToUser);
  }

  /**
   * US-5: validate credentials and, on success, create a `sessions_auth` row.
   * Returns the new session id (placed in the httpOnly cookie) and the user.
   * Throws {@link InvalidCredentialsError} (→ 401) on bad username/password or
   * an inactive account. Writes `secret_access` (credential read) + `login`
   * audit rows (FR-A3).
   */
  async login(
    input: { username: string; password: string },
    ctx: RequestContext = {},
  ): Promise<{ sessionId: string; user: User }> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);

    // Credential material read → auditable (FR-A3). Recorded regardless of the
    // verification outcome so failed-login probes are visible; targetId is the
    // user id when found, else the attempted username.
    await this.audit.record({
      action: 'secret_access',
      userId: row?.id ?? null,
      targetType: 'user_credential',
      targetId: row?.id ?? input.username,
      ip: ctx.ip ?? null,
      detail: { purpose: 'login' },
    });

    if (!row || !row.isActive) {
      // Run a verify against a dummy to keep timing roughly uniform when the
      // user is missing, then fail closed.
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        input.password,
      );
      throw new InvalidCredentialsError();
    }

    const ok = await verifyPassword(row.passwordHash, input.password);
    if (!ok) {
      throw new InvalidCredentialsError();
    }

    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insert(sessionsAuth).values({
      id: sessionId,
      userId: row.id,
      expiresAt,
      userAgent: ctx.userAgent ?? null,
    });

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, row.id));

    await this.audit.record({
      action: 'login',
      userId: row.id,
      targetType: 'user',
      targetId: row.id,
      ip: ctx.ip ?? null,
      detail: null,
    });

    return { sessionId, user: rowToUser(row) };
  }

  /**
   * US-5: resolve the acting user from a session-cookie id. Returns the user
   * when the session is present, unrevoked, unexpired, and the account is
   * active; otherwise `null` (the middleware turns null into 401).
   */
  async getUserBySession(sessionId: string): Promise<User | null> {
    // A malformed cookie is just "not authenticated", never a 500.
    if (!UUID_RE.test(sessionId)) {
      return null;
    }
    const rows = await this.db
      .select({ user: users })
      .from(sessionsAuth)
      .innerJoin(users, eq(sessionsAuth.userId, users.id))
      .where(
        and(
          eq(sessionsAuth.id, sessionId),
          isNull(sessionsAuth.revokedAt),
          gt(sessionsAuth.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const hit = rows[0];
    if (!hit || !hit.user.isActive) {
      return null;
    }
    return rowToUser(hit.user);
  }

  /**
   * US-5: logout — revoke the session row (idempotent). Writes a `logout`
   * audit row attributed to the session's owner when the session existed.
   */
  async logout(sessionId: string, ctx: RequestContext = {}): Promise<void> {
    const [revoked] = await this.db
      .update(sessionsAuth)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessionsAuth.id, sessionId), isNull(sessionsAuth.revokedAt)))
      .returning({ userId: sessionsAuth.userId });

    if (revoked) {
      await this.audit.record({
        action: 'logout',
        userId: revoked.userId,
        targetType: 'session',
        targetId: sessionId,
        ip: ctx.ip ?? null,
        detail: null,
      });
    }
  }

  /**
   * Change the signed-in user's own password. Verifies the CURRENT password
   * first (so a hijacked open session can't silently re-key the account), then
   * writes a fresh argon2id hash. Throws {@link InvalidCredentialsError} (→ 401)
   * when the current password is wrong or the account is inactive.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    ctx: RequestContext = {},
  ): Promise<void> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !row.isActive) {
      throw new InvalidCredentialsError();
    }
    const ok = await verifyPassword(row.passwordHash, input.currentPassword);
    if (!ok) {
      throw new InvalidCredentialsError();
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    // No dedicated audit action exists; record the credential write as secret_access.
    await this.audit.record({
      action: 'secret_access',
      userId,
      targetType: 'user_credential',
      targetId: userId,
      ip: ctx.ip ?? null,
      detail: { purpose: 'password_change' },
    });
  }

  /**
   * Update the user's profile (display name). A blank/whitespace name clears it
   * (stored null → the UI falls back to the username). Returns the updated user,
   * or null when the id is unknown/inactive. Not security-sensitive, so unaudited.
   */
  async updateProfile(
    userId: string,
    input: { displayName: string | null },
  ): Promise<User | null> {
    const trimmed = input.displayName?.trim();
    const displayName = trimmed && trimmed.length > 0 ? trimmed : null;
    const [row] = await this.db
      .update(users)
      .set({ displayName })
      .where(eq(users.id, userId))
      .returning();
    return row ? rowToUser(row) : null;
  }
}
