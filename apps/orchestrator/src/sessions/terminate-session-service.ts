/**
 * TerminateSessionService — US-13: terminate a session (FR-S5).
 *
 * `DELETE /api/sessions/:id` does four things, in order:
 *   1. kill the daemon session that owns the agent process (best-effort);
 *   2. tear down the per-session browser harness, if one was ever started
 *      (best-effort; Phase-4/US-25 wires the concrete harness in);
 *   3. mark the single authoritative record closed (`closed_at`), which also
 *      removes it from the boot re-attach candidate set (FR-S4);
 *   4. write a `session_terminate` audit row (FR-A3).
 *
 * The single authoritative session record (spec §4.2) is what makes terminate
 * safe and complete: ONE session_id names the daemon session, scopes the hook
 * token, and binds the browser endpoint — so killing by that one record tears
 * down every resource the session owns, with no chance of a divergent handle.
 *
 * Teardown of the session + browser is BEST-EFFORT: a kill that fails (e.g. the
 * daemon session is already gone, or the node link is down) must not leave the
 * record half-terminated. We therefore swallow teardown errors, ALWAYS mark the
 * record closed, and ALWAYS write the audit row. The kills are idempotent anyway
 * ({@link SessionTerminator.killSession} swallows a missing session), so a later
 * boot re-attach will not resurrect a closed session.
 *
 * Collaborators are injected behind small interfaces so this service is unit-
 * testable without a real daemon, Postgres, or Chrome. Postgres here is the
 * REGISTRY/identity write path — NOT the live status path (spec §6.6).
 */
import type { Session } from '@flock/shared';

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
  getSession(id: string): Promise<Session | null>;
  /** Mark the record closed (sets `closed_at`); excludes it from boot re-attach. */
  markClosed(id: string, closedAt: string): Promise<void>;
}

/**
 * Optional per-session browser-harness teardown (FR-B6 / US-25, Phase 4). When a
 * session has a `browserCdpEndpoint`, its isolated Chrome container must be torn
 * down on terminate. The concrete harness is not built in Phase 2, so this is an
 * OPTIONAL injected dependency: when absent, terminate skips browser teardown;
 * when present, US-25 supplies the real container-removal impl. Passing the whole
 * {@link Session} keeps the single-authoritative-record thread-through intact —
 * the harness keys off the SAME record that owns the session name + hook token.
 */
export interface BrowserHarnessTeardown {
  teardown(session: Session): Promise<void>;
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
  /** Optional browser-harness teardown (Phase 4/US-25); omitted in Phase 2. */
  browser?: BrowserHarnessTeardown;
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
  private readonly browser?: BrowserHarnessTeardown;

  constructor(deps: TerminateSessionServiceDeps) {
    this.terminator = deps.terminator;
    this.registry = deps.registry;
    this.audit = deps.audit;
    this.browser = deps.browser;
  }

  /**
   * Terminate a session (US-13, FR-S5).
   *
   * Throws {@link SessionNotFoundError} (→ 404) for an unknown session, mutating
   * nothing and writing no audit row (spec §10 edge case). For an ALREADY-closed
   * session this is idempotent: it returns the existing close timestamp without
   * re-killing the daemon session, re-tearing-down the browser, or writing a
   * duplicate audit row. Otherwise it kills the session + browser (best-effort),
   * marks the record closed, and writes ONE `session_terminate` audit row.
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

    // 2) Tear down the per-session browser harness IFF one was started and a
    //    teardown collaborator is wired in (Phase 4/US-25). Best-effort.
    if (this.browser && session.browserCdpEndpoint !== null) {
      try {
        await this.browser.teardown(session);
      } catch {
        // best-effort teardown — fall through to close + audit.
      }
    }

    // 3) Mark the authoritative record closed (FR-S5). This removes it from the
    //    boot re-attach candidate set so a restart never resurrects it (FR-S4).
    const closedAt = new Date().toISOString();
    await this.registry.markClosed(session.id, closedAt);

    // 4) Append the security-relevant audit row (FR-A3). Off the live path.
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
