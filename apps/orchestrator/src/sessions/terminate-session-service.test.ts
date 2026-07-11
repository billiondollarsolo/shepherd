/**
 * US-13 — TerminateSessionService unit tests (run under `pnpm test:unit`).
 *
 * `DELETE /api/sessions/:id` kills the daemon session + any per-session browser
 * harness, marks the authoritative record closed, and writes a
 * `session_terminate` audit row (FR-S5). These unit tests use FAKE collaborators
 * (a fake session terminator, an in-memory registry, an optional fake browser
 * harness, and a fake audit sink) so they are pure: no real daemon, no real DB.
 * The real-services path is covered by terminate-session.int.test.ts.
 *
 * Acceptance-critical assertions (spec §9 US-13, §10 edge cases, §4.2 invariant):
 *   - terminate kills the session by the record's tmux_session_name;
 *   - terminate tears down the browser harness IFF the record has a CDP endpoint,
 *     and the SAME session_id threads the session name + hook token + CDP endpoint
 *     that teardown acts on (single authoritative record, §4.2/§15);
 *   - the record is marked closed (closed_at set; excluded from open sessions);
 *   - exactly ONE `session_terminate` audit row is written, attributed to the
 *     acting user with the request ip and target = the session id;
 *   - terminating an unknown session throws SessionNotFoundError (→ 404) and
 *     mutates nothing / writes no audit row (§10);
 *   - terminating an already-closed session is idempotent: no second kill,
 *     no second audit row;
 *   - teardown is best-effort: a kill/browser failure still closes the record
 *     and still writes the audit row (work must not be left half-terminated).
 */
import { describe, expect, it } from 'vitest';

import type { Session } from '@flock/shared';

import type { AuditEntry, AuditSink } from '../audit/audit.js';
import { AuditLogger } from '../audit/audit.js';
import {
  SessionNotFoundError,
  TerminateSessionService,
  type BrowserHarnessTeardown,
  type TerminableSessionRegistry,
  type SessionTerminator,
} from './terminate-session-service.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function makeSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  const now = '2026-05-29T00:00:00.000Z';
  return {
    id,
    nodeId: NODE_ID,
    projectId: PROJECT_ID,
    agentType: 'claude-code',
    tmuxSessionName: `flock-${id}`,
    workingDir: '/w',
    browserCdpEndpoint: null,
    hookTokenHash: `argon2id$${id}`,
    status: 'running',
    statusDetail: null,
    createdAt: now,
    lastStatusAt: now,
    createdBy: USER_ID,
    closedAt: null,
    ...overrides,
  };
}

/** Records kill calls; no real daemon. */
class FakeTerminator implements SessionTerminator {
  readonly killed: string[] = [];
  shouldThrow = false;
  async killSession(sessionName: string): Promise<void> {
    this.killed.push(sessionName);
    if (this.shouldThrow) throw new Error('session kill failed');
  }
}

/** In-memory registry standing in for the Drizzle-backed one (no real DB). */
class FakeRegistry implements TerminableSessionRegistry {
  readonly rows: Session[] = [];
  readonly markClosedCalls: Array<{ id: string; closedAt: string }> = [];

  constructor(initial: Session[] = []) {
    this.rows.push(...initial);
  }

  async getSession(id: string): Promise<Session | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async markClosed(id: string, closedAt: string): Promise<void> {
    this.markClosedCalls.push({ id, closedAt });
    const row = this.rows.find((r) => r.id === id);
    if (row) (row as { closedAt: string | null }).closedAt = closedAt;
  }

  async listOpenSessions(): Promise<Session[]> {
    return this.rows.filter((r) => r.closedAt === null);
  }
}

/** Records harness teardown calls; no real Chrome/docker. */
class FakeBrowserHarness implements BrowserHarnessTeardown {
  readonly tornDown: Session[] = [];
  shouldThrow = false;
  async teardown(session: Session): Promise<void> {
    this.tornDown.push(session);
    if (this.shouldThrow) throw new Error('browser harness teardown failed');
  }
}

class FakeSink implements AuditSink {
  readonly rows: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.rows.push(entry);
  }
}

function build(
  opts: {
    sessions?: Session[];
    browser?: FakeBrowserHarness;
  } = {},
) {
  const terminator = new FakeTerminator();
  const registry = new FakeRegistry(opts.sessions ?? []);
  const sink = new FakeSink();
  const audit = new AuditLogger(sink);
  const service = new TerminateSessionService({
    terminator,
    registry,
    audit,
    browser: opts.browser,
  });
  return { terminator, registry, sink, service, browser: opts.browser };
}

describe('TerminateSessionService.terminate (US-13, FR-S5)', () => {
  it('kills the daemon session by the record tmux_session_name and marks it closed', async () => {
    const session = makeSession();
    const { terminator, registry, service } = build({ sessions: [session] });

    const result = await service.terminate(session.id, { userId: USER_ID, ip: '1.2.3.4' });

    // Session killed with the record's name (not the bare id).
    expect(terminator.killed).toEqual([session.tmuxSessionName]);
    // Record marked closed -> excluded from the open set (no longer a boot candidate).
    expect(registry.markClosedCalls).toHaveLength(1);
    expect(registry.markClosedCalls[0]!.id).toBe(session.id);
    expect(await registry.listOpenSessions()).toHaveLength(0);
    // Response echoes the closed id + close timestamp.
    expect(result.sessionId).toBe(session.id);
    expect(result.terminated).toBe(true);
    expect(result.closedAt).toBe(registry.markClosedCalls[0]!.closedAt);
  });

  it('writes exactly ONE session_terminate audit row attributed to the actor (FR-A3)', async () => {
    const session = makeSession();
    const { sink, service } = build({ sessions: [session] });

    await service.terminate(session.id, { userId: USER_ID, ip: '9.9.9.9' });

    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      action: 'session_terminate',
      userId: USER_ID,
      targetType: 'session',
      targetId: session.id,
      ip: '9.9.9.9',
    });
  });

  it('tears down the browser harness when the record has a CDP endpoint (§4.2 thread-through)', async () => {
    const session = makeSession({
      browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-guid',
    });
    const browser = new FakeBrowserHarness();
    const { terminator, service } = build({ sessions: [session], browser });

    await service.terminate(session.id, { userId: USER_ID, ip: null });

    // The SAME session_id threads the session name, the hook token, and the CDP
    // endpoint that teardown acts on — one authoritative record (§4.2/§15).
    expect(browser.tornDown).toHaveLength(1);
    const torn = browser.tornDown[0]!;
    expect(torn.id).toBe(session.id);
    expect(torn.tmuxSessionName).toBe(session.tmuxSessionName);
    expect(torn.hookTokenHash).toBe(session.hookTokenHash);
    expect(torn.browserCdpEndpoint).toBe(session.browserCdpEndpoint);
    expect(terminator.killed).toEqual([session.tmuxSessionName]);
  });

  it('does NOT call browser teardown when the record has no CDP endpoint', async () => {
    const session = makeSession({ browserCdpEndpoint: null });
    const browser = new FakeBrowserHarness();
    const { service } = build({ sessions: [session], browser });

    await service.terminate(session.id, { userId: USER_ID, ip: null });

    expect(browser.tornDown).toHaveLength(0);
  });

  it('works with no browser-harness collaborator injected (Phase 4 not built yet)', async () => {
    const session = makeSession({
      browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-guid',
    });
    const { terminator, registry, service } = build({ sessions: [session] }); // no browser dep

    await expect(
      service.terminate(session.id, { userId: USER_ID, ip: null }),
    ).resolves.toMatchObject({ terminated: true });
    expect(terminator.killed).toEqual([session.tmuxSessionName]);
    expect(registry.markClosedCalls).toHaveLength(1);
  });

  it('throws SessionNotFoundError for an unknown session and mutates nothing (§10)', async () => {
    const { terminator, registry, sink, service } = build({ sessions: [] });

    await expect(
      service.terminate('00000000-0000-4000-8000-000000000000', {
        userId: USER_ID,
        ip: null,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    // No kill, no close, no audit row on a miss.
    expect(terminator.killed).toHaveLength(0);
    expect(registry.markClosedCalls).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('is idempotent for an already-closed session: no second kill, no second audit row (§10)', async () => {
    const session = makeSession({ closedAt: '2026-05-29T00:00:01.000Z' });
    const { terminator, registry, sink, service } = build({ sessions: [session] });

    const result = await service.terminate(session.id, { userId: USER_ID, ip: null });

    // Idempotent close: returns the existing closedAt, does not re-kill/re-audit.
    expect(result.terminated).toBe(true);
    expect(result.closedAt).toBe('2026-05-29T00:00:01.000Z');
    expect(terminator.killed).toHaveLength(0);
    expect(registry.markClosedCalls).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('still closes the record + writes the audit row when the kill fails (best-effort teardown)', async () => {
    const session = makeSession();
    const { terminator, registry, sink, service } = build({ sessions: [session] });
    terminator.shouldThrow = true;

    const result = await service.terminate(session.id, { userId: USER_ID, ip: null });

    expect(result.terminated).toBe(true);
    expect(terminator.killed).toEqual([session.tmuxSessionName]); // attempted
    expect(registry.markClosedCalls).toHaveLength(1); // still closed
    expect(sink.rows).toHaveLength(1); // still audited
    expect(sink.rows[0]).toMatchObject({ action: 'session_terminate' });
  });

  it('still closes the record + audits when browser teardown fails (best-effort)', async () => {
    const session = makeSession({
      browserCdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-guid',
    });
    const browser = new FakeBrowserHarness();
    browser.shouldThrow = true;
    const { registry, sink, service } = build({ sessions: [session], browser });

    const result = await service.terminate(session.id, { userId: USER_ID, ip: null });

    expect(result.terminated).toBe(true);
    expect(registry.markClosedCalls).toHaveLength(1);
    expect(sink.rows).toHaveLength(1);
  });
});
