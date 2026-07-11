import { describe, expect, it } from 'vitest';
import {
  AUDIT_MAX_LIMIT,
  ClientMessage,
  CreateNodeRequest,
  CreateSessionResponse,
  ListAuditQuery,
  ListAuditResponse,
  ServerMessage,
  StatusUpdateMessage,
} from './contracts.js';
import { ClaudeHookPayload, CodexHookPayload, OpenCodeHookPayload } from './hooks.js';
import { SessionSchema, type SessionRecord } from './domain.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function sampleSession(): SessionRecord {
  return {
    id: SESSION_ID,
    nodeId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    agentType: 'codex',
    tmuxSessionName: `flock-${SESSION_ID}`,
    workingDir: '/home/dev/project',
    browserCdpEndpoint: null,
    hookTokenHash: 'hash',
    status: 'starting',
    statusDetail: null,
    pinned: false,
    note: null,
    reviewedAt: null,
    permissionMode: 'default',
    createdAt: '2026-05-29T00:00:00.000Z',
    lastStatusAt: '2026-05-29T00:00:00.000Z',
    createdBy: '44444444-4444-4444-8444-444444444444',
    closedAt: null,
  };
}

describe('REST contract round-trips (spec §8.1)', () => {
  it('CreateSessionResponse strips agent-only token and internal record fields', () => {
    const value = { session: sampleSession(), hookToken: 'plaintext-once' };
    const parsed = CreateSessionResponse.parse(value);
    expect(parsed).not.toHaveProperty('hookToken');
    expect(parsed.session).not.toHaveProperty('hookTokenHash');
    expect(parsed.session).not.toHaveProperty('tmuxSessionName');
    expect(parsed.session).not.toHaveProperty('browserCdpEndpoint');
    expect(parsed.session).not.toHaveProperty('createdBy');
    expect(parsed.session.id).toBe(SESSION_ID);
    // Round-trip is idempotent.
    expect(CreateSessionResponse.parse(parsed)).toEqual(parsed);
  });

  it('CreateNodeRequest requires ssh fields only for ssh nodes', () => {
    expect(CreateNodeRequest.safeParse({ name: 'local', kind: 'local' }).success).toBe(true);
    expect(CreateNodeRequest.safeParse({ name: 'box', kind: 'ssh' }).success).toBe(false);
    expect(
      CreateNodeRequest.safeParse({
        name: 'box',
        kind: 'ssh',
        host: 'box.example.com',
        sshUser: 'dev',
        sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
      }).success,
    ).toBe(true);
  });

  it('SessionSchema is an allowlisted public projection', () => {
    const parsed = SessionSchema.parse(sampleSession());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'agentType',
        'closedAt',
        'createdAt',
        'id',
        'lastStatusAt',
        'nodeId',
        'note',
        'permissionMode',
        'pinned',
        'projectId',
        'reviewedAt',
        'status',
        'statusDetail',
        'workingDir',
      ].sort(),
    );
  });
});

describe('GET /api/audit contracts (US-40, FR-A3)', () => {
  const USER_ID = '44444444-4444-4444-8444-444444444444';

  it('ListAuditQuery accepts an empty query (all optional)', () => {
    expect(ListAuditQuery.parse({})).toEqual({});
  });

  it('ListAuditQuery coerces string limit/offset from the query string', () => {
    const parsed = ListAuditQuery.parse({ limit: '50', offset: '10' });
    expect(parsed).toEqual({ limit: 50, offset: 10 });
  });

  it('ListAuditQuery narrows by action and userId', () => {
    const parsed = ListAuditQuery.parse({ action: 'login', userId: USER_ID });
    expect(parsed).toEqual({ action: 'login', userId: USER_ID });
  });

  it('ListAuditQuery rejects an unknown action and an over-cap limit', () => {
    expect(ListAuditQuery.safeParse({ action: 'not_an_action' }).success).toBe(false);
    expect(ListAuditQuery.safeParse({ limit: AUDIT_MAX_LIMIT + 1 }).success).toBe(false);
    expect(ListAuditQuery.safeParse({ offset: -1 }).success).toBe(false);
    expect(ListAuditQuery.safeParse({ userId: 'not-a-uuid' }).success).toBe(false);
  });

  it('ListAuditResponse round-trips a list of audit entries', () => {
    const value = {
      entries: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          ts: '2026-05-29T00:00:00.000Z',
          userId: USER_ID,
          action: 'login' as const,
          targetType: 'user',
          targetId: USER_ID,
          ip: '1.2.3.4',
          detail: null,
        },
      ],
    };
    expect(ListAuditResponse.parse(value)).toEqual(value);
  });
});

describe('WS contract round-trips (spec §8.2)', () => {
  it('StatusUpdateMessage round-trips and is part of the ServerMessage union', () => {
    const msg = {
      channel: 'status' as const,
      sessionId: SESSION_ID,
      status: 'awaiting_input' as const,
      detail: 'permission prompt',
      ts: '2026-05-29T00:00:00.000Z',
    };
    expect(StatusUpdateMessage.parse(msg)).toEqual(msg);
    expect(ServerMessage.parse(msg)).toEqual(msg);
  });

  it('StatusUpdateMessage carries optional live telemetry (meta) — polling→WS', () => {
    const msg = {
      channel: 'status' as const,
      sessionId: SESSION_ID,
      status: 'running' as const,
      detail: null,
      ts: '2026-05-29T00:00:00.000Z',
      meta: { tokens: 1234, tool: 'Edit', model: 'claude', contextPct: 37, costUsd: 0.12 },
    };
    expect(StatusUpdateMessage.parse(msg)).toEqual(msg);
    expect(ServerMessage.parse(msg)).toEqual(msg);
  });

  it('ClientMessage discriminates on op', () => {
    const subscribe = { op: 'subscribe' as const, channel: 'pty' as const, sessionId: SESSION_ID };
    const resize = { op: 'pty:resize' as const, sessionId: SESSION_ID, cols: 120, rows: 40 };
    expect(ClientMessage.parse(subscribe)).toEqual(subscribe);
    expect(ClientMessage.parse(resize)).toEqual(resize);
    expect(ClientMessage.safeParse({ op: 'nope' }).success).toBe(false);
  });
});

describe('Agent hook payload round-trips (spec §7.1)', () => {
  it('Claude Code permission prompt payload parses (passthrough keeps extras)', () => {
    const payload = {
      hook_event_name: 'Notification' as const,
      notification_type: 'permission_prompt' as const,
      session_id: 'abc',
      extra_field: 'kept',
    };
    const parsed = ClaudeHookPayload.parse(payload);
    expect(parsed.hook_event_name).toBe('Notification');
    expect((parsed as Record<string, unknown>).extra_field).toBe('kept');
  });

  it('Codex PostToolUse failure payload parses', () => {
    const payload = { event: 'PostToolUse' as const, success: false, exit_code: 1 };
    expect(CodexHookPayload.parse(payload)).toMatchObject(payload);
  });

  it('OpenCode session.idle payload parses', () => {
    const payload = { type: 'session.idle' as const, sessionID: 'xyz' };
    expect(OpenCodeHookPayload.parse(payload)).toMatchObject(payload);
  });
});
