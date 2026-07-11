import { describe, expect, it } from 'vitest';
import { SessionRecordSchema, type SessionRecord } from './domain.js';

/**
 * Single authoritative session record invariant (spec §4.2, §6, §15).
 *
 * One `session_id` (the record's `id`) names the tmux session, scopes the hook
 * token, and binds the browser endpoint. The shared schema is the contract that
 * keeps these threaded through ONE record; this test fails if any of those
 * binding fields are dropped from the schema (which would let the three
 * identities diverge across separate records).
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function sampleSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    nodeId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    agentType: 'claude-code',
    tmuxSessionName: `flock-${SESSION_ID}`,
    workingDir: '/home/dev/project',
    browserCdpEndpoint: `ws://127.0.0.1:9222/devtools/browser/${SESSION_ID}`,
    hookTokenHash: 'argon2id$hash$for$session$token',
    status: 'running',
    statusDetail: null,
    pinned: false,
    note: null,
    reviewedAt: null,
    permissionMode: 'default',
    orchestrationAuthority: 'callback_only',
    createdAt: '2026-05-29T00:00:00.000Z',
    lastStatusAt: '2026-05-29T00:00:00.000Z',
    createdBy: '44444444-4444-4444-8444-444444444444',
    closedAt: null,
    ...overrides,
  };
}

describe('Session single-record invariant (§4.2)', () => {
  it('one record carries the tmux name, hook token hash, and browser endpoint together', () => {
    const session = SessionRecordSchema.parse(sampleSession());

    // All three identities live on the SAME record keyed by the one session_id.
    expect(session.id).toBe(SESSION_ID);
    expect(session.tmuxSessionName).toContain(SESSION_ID);
    expect(session.browserCdpEndpoint).toContain(SESSION_ID);
    expect(session.hookTokenHash.length).toBeGreaterThan(0);
  });

  it('requires the binding fields — the schema fails if any is missing', () => {
    for (const field of ['tmuxSessionName', 'hookTokenHash'] as const) {
      const broken: Record<string, unknown> = { ...sampleSession() };
      delete broken[field];
      expect(SessionRecordSchema.safeParse(broken).success).toBe(false);
    }
  });

  it('allows browserCdpEndpoint to be null before a browser is started', () => {
    const session = SessionRecordSchema.parse(sampleSession({ browserCdpEndpoint: null }));
    expect(session.browserCdpEndpoint).toBeNull();
  });

  it('rejects a divergent browser endpoint that is not a valid url', () => {
    const result = SessionRecordSchema.safeParse(
      sampleSession({ browserCdpEndpoint: 'not-a-url' }),
    );
    expect(result.success).toBe(false);
  });
});
