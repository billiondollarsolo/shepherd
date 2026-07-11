/**
 * Flock — DB row <-> shared domain type mappers.
 *
 * The shared `Session` type/contract lives in `@flock/shared` (domain.ts) and is
 * the single source of truth used by BOTH the orchestrator and the web app.
 * These helpers translate between the Drizzle `agent_sessions` row shape and that
 * shared shape so the domain type is never duplicated.
 *
 * They also encode the single authoritative session record invariant (spec
 * §4.2): the row `id` (the session_id) threads the tmux session name, the hook
 * token hash, and the browser CDP endpoint into ONE record.
 */
import type {
  AgentAuthority,
  AgentType,
  AuditAction,
  AuditEntry,
  Node as SharedNode,
  Project as SharedProject,
  SessionRecord,
  SessionPermissionMode,
  Status,
} from '@flock/shared';
import { DEFAULT_PROJECT_AGENT_POLICY, ProjectAgentPolicySchema } from '@flock/shared';

import type {
  AgentSessionRow,
  AuditLogRow,
  NewAgentSessionRow,
  NodeRow,
  ProjectRow,
} from './schema.js';

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

/**
 * Map a persisted `agent_sessions` row to the shared `Session` domain type.
 * Threads the single authoritative identity (tmux + hook token + CDP) through
 * the one session_id.
 */
export function rowToSession(row: AgentSessionRow): SessionRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    projectId: row.projectId,
    agentType: row.agentType as AgentType,
    tmuxSessionName: row.tmuxSessionName,
    workingDir: row.workingDir,
    browserCdpEndpoint: row.browserCdpEndpoint ?? null,
    hookTokenHash: row.hookTokenHash,
    status: row.status as Status,
    statusDetail: row.statusDetail ?? null,
    pinned: row.pinned ?? false,
    note: row.note ?? null,
    reviewedAt: toIsoOrNull(row.reviewedAt),
    permissionMode: (row.permissionMode ?? 'default') as SessionPermissionMode,
    orchestrationAuthority: (row.orchestrationAuthority ?? 'callback_only') as AgentAuthority,
    createdAt: toIso(row.createdAt),
    lastStatusAt: toIso(row.lastStatusAt),
    createdBy: row.createdBy,
    closedAt: toIsoOrNull(row.closedAt),
  };
}

/**
 * Map a shared `Session` to an insertable/updatable row. `id` is the session_id;
 * the threaded identity (tmux + hook token hash + CDP) is preserved exactly.
 */
export function sessionToRow(session: SessionRecord): NewAgentSessionRow {
  return {
    id: session.id,
    nodeId: session.nodeId,
    projectId: session.projectId,
    agentType: session.agentType,
    tmuxSessionName: session.tmuxSessionName,
    workingDir: session.workingDir,
    browserCdpEndpoint: session.browserCdpEndpoint ?? null,
    hookTokenHash: session.hookTokenHash,
    status: session.status,
    statusDetail: session.statusDetail ?? null,
    pinned: session.pinned ?? false,
    note: session.note ?? null,
    permissionMode: session.permissionMode ?? 'default',
    orchestrationAuthority: session.orchestrationAuthority ?? 'callback_only',
    createdAt: new Date(session.createdAt),
    lastStatusAt: new Date(session.lastStatusAt),
    createdBy: session.createdBy,
    closedAt: session.closedAt ? new Date(session.closedAt) : null,
  };
}

/** Map a `nodes` row to the shared `Node` domain type. */
export function rowToNode(row: NodeRow): SharedNode {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SharedNode['kind'],
    host: row.host ?? null,
    port: row.port ?? null,
    sshUser: row.sshUser ?? null,
    sshKeyRef: row.sshKeyRef ?? null,
    sshAuthMethod: (row.sshAuthMethod as SharedNode['sshAuthMethod']) ?? null,
    pool: row.pool ?? null,
    connectionStatus: row.connectionStatus as SharedNode['connectionStatus'],
    lastSeenAt: toIsoOrNull(row.lastSeenAt),
    createdBy: row.createdBy ?? '',
    createdAt: toIso(row.createdAt),
  };
}

/** Map a `projects` row to the shared `Project` domain type. */
export function rowToProject(row: ProjectRow): SharedProject {
  return {
    id: row.id,
    nodeId: row.nodeId,
    name: row.name,
    workingDir: row.workingDir,
    agentPolicy: ProjectAgentPolicySchema.parse(row.agentPolicy ?? DEFAULT_PROJECT_AGENT_POLICY),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * Map an `audit_log` row to the shared `AuditEntry` domain type (US-40, FR-A3).
 * The `detail` column is stored as a JSON string by the audit sink; it is kept
 * as that opaque string here (the shared contract types it as `string | null`),
 * so the admin UI shows it verbatim and no plaintext is ever re-parsed/leaked.
 */
export function rowToAuditEntry(row: AuditLogRow): AuditEntry {
  return {
    id: row.id,
    ts: toIso(row.ts),
    userId: row.userId ?? null,
    action: row.action as AuditAction,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    ip: row.ip ?? null,
    detail: row.detail ?? null,
  };
}
