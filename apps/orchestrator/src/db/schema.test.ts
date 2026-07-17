/**
 * Shepherd — US-2 data-model UNIT tests (no database; runs under `pnpm test:unit`).
 *
 *  - schema exposes all spec §6 tables;
 *  - DB enum column tuples are DERIVED from @flock/shared (never duplicated);
 *  - the row <-> shared `Session` mapper round-trips;
 *  - the mapper preserves the single authoritative session record identity
 *    (one session_id threads tmux name + hook token hash, spec §4.2).
 */
import { describe, expect, it } from 'vitest';

import {
  AgentTypeEnum,
  AgentAuthorityEnum,
  AuditActionEnum,
  ConnectionStatusEnum,
  EventSourceEnum,
  NodeKindEnum,
  SecretKindEnum,
  SessionPermissionModeEnum,
  SshAuthMethodEnum,
  SessionSchema,
  STATUS_VALUES,
  type Session,
} from '@flock/shared';

import {
  agentSessions,
  agentCapabilities,
  authLoginThrottle,
  auditLog,
  events,
  nodes,
  projects,
  projectServices,
  previewRuntimeSettings,
  pushSubscriptions,
  schema,
  secrets,
  sessionsAuth,
  users,
  type AgentSessionRow,
} from './schema.js';
import { rowToSession, sessionToRow } from './mappers.js';

describe('schema (§6) — all required tables exist', () => {
  it('exposes every spec §6 table', () => {
    for (const t of [
      users,
      sessionsAuth,
      authLoginThrottle,
      nodes,
      projects,
      projectServices,
      previewRuntimeSettings,
      agentSessions,
      agentCapabilities,
      events,
      pushSubscriptions,
      auditLog,
      secrets,
    ]) {
      expect(t).toBeDefined();
    }
  });

  it('registers all tables on the schema barrel for the drizzle client', () => {
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        'users',
        'sessionsAuth',
        'authLoginThrottle',
        'secrets',
        'nodes',
        'projects',
        'projectServices',
        'previewRuntimeSettings',
        'agentSessions',
        'agentCapabilities',
        'events',
        'pushSubscriptions',
        'auditLog',
      ]),
    );
  });
});

describe('enum columns are the single source of truth from @flock/shared', () => {
  // Drizzle exposes each text-enum column's constraint on `.enumValues`. These
  // assertions are the GUARDRAIL: the DB column constraints must EXACTLY equal
  // the shared zod enums, so the literals declared in schema.ts (required so
  // `drizzle-kit generate` can bundle the schema as CJS) can never drift from
  // @flock/shared without failing CI. Never duplicate a type — this enforces it.
  it('agent_sessions.status and events.mapped_status match the shared StatusEnum', () => {
    expect(agentSessions.status.enumValues).toEqual([...STATUS_VALUES]);
    expect(events.status.enumValues).toEqual([...STATUS_VALUES]);
  });

  it('nodes.kind / nodes.connection_status / nodes.ssh_auth_method match the shared enums', () => {
    expect(nodes.kind.enumValues).toEqual([...NodeKindEnum.options]);
    expect(nodes.connectionStatus.enumValues).toEqual([...ConnectionStatusEnum.options]);
    expect(nodes.sshAuthMethod.enumValues).toEqual([...SshAuthMethodEnum.options]);
  });

  it('agent_sessions.permission_mode matches the shared SessionPermissionModeEnum', () => {
    expect(agentSessions.permissionMode.enumValues).toEqual([...SessionPermissionModeEnum.options]);
  });

  it('agent_sessions orchestration authority matches the shared AgentAuthorityEnum', () => {
    expect(agentSessions.orchestrationAuthority.enumValues).toEqual([
      ...AgentAuthorityEnum.options,
    ]);
  });

  it('agent_sessions.agent_type matches the shared AgentTypeEnum', () => {
    expect(agentSessions.agentType.enumValues).toEqual([...AgentTypeEnum.options]);
  });

  it('events.source matches the shared EventSourceEnum', () => {
    expect(events.source.enumValues).toEqual([...EventSourceEnum.options]);
  });

  it('secrets.kind matches the shared SecretKindEnum', () => {
    expect(secrets.kind.enumValues).toEqual([...SecretKindEnum.options]);
  });

  it('audit_log.action matches the shared AuditActionEnum', () => {
    expect(auditLog.action.enumValues).toEqual([...AuditActionEnum.options]);
  });
});

describe('Session mapper (US-2) — round-trips & identity invariant', () => {
  const now = new Date('2026-05-29T12:00:00.000Z');
  const baseRow: AgentSessionRow = {
    id: '11111111-1111-4111-8111-111111111111',
    nodeId: '33333333-3333-4333-8333-333333333333',
    projectId: '22222222-2222-4222-8222-222222222222',
    agentType: AgentTypeEnum.options[0], // 'claude-code'
    tmuxSessionName: 'flock-sess-abc',
    workingDir: '/home/dev/project',
    hookTokenHash: 'argon2id$hash$abc',
    status: 'running',
    statusDetail: null,
    note: null,
    permissionMode: 'default',
    model: null,
    reasoningEffort: null,
    structuredChat: false,
    orchestrationAuthority: 'callback_only',
    createdAt: now,
    lastStatusAt: now,
    createdBy: '44444444-4444-4444-8444-444444444444',
    closedAt: null,
  };

  it('maps a DB row to the shared Session contract', () => {
    const session = rowToSession(baseRow);
    // Validates against the shared zod contract (no duplicated type).
    expect(() => SessionSchema.parse(session)).not.toThrow();
    expect(session.id).toBe(baseRow.id);
    expect(session.createdAt).toBe(now.toISOString());
    expect(session.permissionMode).toBe('default');
  });

  it('round-trips row -> shared -> row without losing identity', () => {
    const session = rowToSession(baseRow);
    const back = sessionToRow(session);
    expect(back.id).toBe(baseRow.id);
    expect(back.tmuxSessionName).toBe(baseRow.tmuxSessionName);
    expect(back.hookTokenHash).toBe(baseRow.hookTokenHash);
  });

  it('threads tmux + hook token hash through ONE session_id', () => {
    const session: Session = rowToSession(baseRow);
    // The single authoritative session record invariant (§4.2): one id binds all.
    expect(session.id).toBe(baseRow.id);
    expect(session.tmuxSessionName).toBeTruthy();
    expect(session.hookTokenHash).toBeTruthy();
    expect(session.closedAt).toBeNull();
  });

  it('keeps the agent type within the shared AgentTypeEnum', () => {
    const session = rowToSession(baseRow);
    expect(AgentTypeEnum.options).toContain(session.agentType);
  });

  it('keeps connection status enum derived from shared (sanity on derivation)', () => {
    expect(ConnectionStatusEnum.options.length).toBeGreaterThan(0);
  });
});
