import { describe, expect, it } from 'vitest';
import { SessionRecordSchema, type SessionRecord } from './domain.js';

/**
 * Single authoritative session record invariant (spec §4.2, §6, §15).
 *
 * One `session_id` (the record's `id`) names the tmux session, scopes the hook
 * token. Remote Preview is deliberately an ephemeral, revocable capability and
 * therefore does not belong in this durable record.
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
    hookTokenHash: 'argon2id$hash$for$session$token',
    status: 'running',
    statusDetail: null,
    note: null,
    permissionMode: 'default',
    model: null,
    reasoningEffort: null,
    structuredChat: false,
    orchestrationAuthority: 'callback_only',
    createdAt: '2026-05-29T00:00:00.000Z',
    lastStatusAt: '2026-05-29T00:00:00.000Z',
    createdBy: '44444444-4444-4444-8444-444444444444',
    closedAt: null,
    ...overrides,
  };
}

describe('Session single-record invariant (§4.2)', () => {
  it('one record carries the tmux name and hook-token binding together', () => {
    const session = SessionRecordSchema.parse(sampleSession());

    // Both durable identities live on the SAME record keyed by one session id.
    expect(session.id).toBe(SESSION_ID);
    expect(session.tmuxSessionName).toContain(SESSION_ID);
    expect(session.hookTokenHash.length).toBeGreaterThan(0);
  });

  it('requires the binding fields — the schema fails if any is missing', () => {
    for (const field of ['tmuxSessionName', 'hookTokenHash'] as const) {
      const broken: Record<string, unknown> = { ...sampleSession() };
      delete broken[field];
      expect(SessionRecordSchema.safeParse(broken).success).toBe(false);
    }
  });
});
