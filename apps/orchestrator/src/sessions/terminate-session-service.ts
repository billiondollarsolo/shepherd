/**
 * TerminateSessionService — US-13: terminate a session (FR-S5).
 *
 * `DELETE /api/sessions/:id` does three things, in order:
 *   1. kill the daemon session that owns the agent process (best-effort);
 *   2. mark the single authoritative record closed (`closed_at`), which also
 *      removes it from the boot re-attach candidate set (FR-S4);
 *   3. write a `session_terminate` audit row (FR-A3).
 *
 * The single authoritative session record (spec §4.2) is what makes terminate
 * safe and complete: ONE session_id names the daemon session, scopes the hook
 * token — so killing by that one record tears down every resource the session
 * owns, with no chance of a divergent handle.
 *
 * Teardown of the session is BEST-EFFORT: a kill that fails (e.g. the
 * daemon session is already gone, or the node link is down) must not leave the
 * record half-terminated. We therefore swallow teardown errors, ALWAYS mark the
 * record closed, and ALWAYS write the audit row. The kills are idempotent anyway
 * ({@link SessionTerminator.killSession} swallows a missing session), so a later
 * boot re-attach will not resurrect a closed session.
 *
 * Collaborators are injected behind small interfaces so this service is unit-
 * testable without a real daemon or Postgres. Postgres here is the
 * REGISTRY/identity write path — NOT the live status path (spec §6.6).
 */
import type { SessionRecord } from '@flock/shared';

import type { AuditLogger } from '../audit/audit.js';

/**
 * The subset of session lifecycle terminate needs: kill the daemon session by
 * its name. Production wires this to flock-agentd's `close(id)`; tests inject a
 * fake. Keeping it to one method keeps the concrete client type out of this service.
 */
export interface SessionTerminator {
  /** Kill the daemon session (idempotent: a missing session is a no-op). */
  killSession(sessionName: string): Promise<void>;
}

/**
 * The registry surface terminate needs: load the authoritative record and mark
 * it closed. The production impl is the Drizzle-backed `DrizzleSessionRegistry`;
 * tests inject an in-memory fake. This is the identity/registry write path, not
 * the live status path (§6.6).
 */
export interface TerminableSessionRegistry {
  /** Load the authoritative record by session_id, or null if unknown. */
  getSession(id: string): Promise<SessionRecord | null>;
  /** Mark the record closed (sets `closed_at`); excludes it from boot re-attach. */
  markClosed(id: string, closedAt: string): Promise<void>;
}

/** Context carried with the audited terminate action (actor + network origin). */
export interface TerminateContext {
  /** The acting user (from the authed session cookie). */
  userId: string;
  /** Source IP of the request, when available. */
  ip?: string | null;
}

/** Outcome of a terminate (mirrors the shared `TerminateSessionResponse`). */
export interface TerminateResult {
  sessionId: string;
  terminated: true;
  closedAt: string;
}

export interface TerminateSessionServiceDeps {
  terminator: SessionTerminator;
  registry: TerminableSessionRegistry;
  audit: AuditLogger;
  revokeCapabilities?: (sessionId: string) => Promise<void>;
}

/** Raised when the session_id does not resolve to a record (→ 404, spec §10). */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" was not found.`);
    this.name = 'SessionNotFoundError';
  }
}

export class TerminateSessionService {
  private readonly terminator: SessionTerminator;
  private readonly registry: TerminableSessionRegistry;
  private readonly audit: AuditLogger;
  private readonly revokeCapabilities?: (sessionId: string) => Promise<void>;

  constructor(deps: TerminateSessionServiceDeps) {
    this.terminator = deps.terminator;
    this.registry = deps.registry;
    this.audit = deps.audit;
    this.revokeCapabilities = deps.revokeCapabilities;
  }

  /**
   * Terminate a session (US-13, FR-S5).
   *
   * Throws {@link SessionNotFoundError} (→ 404) for an unknown session, mutating
   * nothing and writing no audit row (spec §10 edge case). For an ALREADY-closed
   * session this is idempotent: it returns the existing close timestamp without
   * re-killing the daemon session or writing a duplicate audit row. Otherwise it
   * kills the session best-effort, marks the record closed, and writes ONE
   * `session_terminate` audit row.
   */
  async terminate(sessionId: string, ctx: TerminateContext): Promise<TerminateResult> {
    const session = await this.registry.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Idempotency (spec §10): an already-closed session is a no-op. We do not
    // re-kill or re-audit, and we echo the existing close timestamp.
    if (session.closedAt !== null) {
      return { sessionId: session.id, terminated: true, closedAt: session.closedAt };
    }

    // 1) Kill the daemon session that owns the agent process (best-effort). A
    //    missing session is already a no-op in the terminator; any other failure
    //    must NOT block closing the record, so we swallow it here.
    try {
      await this.terminator.killSession(session.tmuxSessionName);
    } catch {
      // best-effort teardown — fall through to close + audit.
    }

    // 2) Mark the authoritative record closed (FR-S5). This removes it from the
    //    boot re-attach candidate set so a restart never resurrects it (FR-S4).
    const closedAt = new Date().toISOString();
    await this.registry.markClosed(session.id, closedAt);
    // Authorization also checks closed_at, so a transient revocation-write
    // failure still fails closed. Persist the explicit marker for audit/cleanup.
    try {
      await this.revokeCapabilities?.(session.id);
    } catch {
      // The closed session fails authorization independently. Keep termination
      // idempotent and let reconciliation retry any explicit marker cleanup.
    }

    // 3) Append the security-relevant audit row (FR-A3). Off the live path.
    await this.audit.record({
      action: 'session_terminate',
      userId: ctx.userId,
      targetType: 'session',
      targetId: session.id,
      ip: ctx.ip ?? null,
      detail: { tmuxSessionName: session.tmuxSessionName, agentType: session.agentType },
    });

    return { sessionId: session.id, terminated: true, closedAt };
  }
}
