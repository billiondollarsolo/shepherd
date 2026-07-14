import { z } from 'zod';
import { StatusEnum } from './status.js';
import { AgentdCompatibilitySchema } from './agentd-compatibility.js';

/**
 * Domain types (spec §6 data model, §4.2 single authoritative session record).
 *
 * These are the shared, app-agnostic shapes imported by BOTH apps. Secret
 * material (password hashes, ssh keys, hook tokens) is never represented in
 * plaintext here — only references / hashes, matching the Postgres schema.
 */

// ---------------------------------------------------------------------------
// Primitive value enums
// ---------------------------------------------------------------------------

export const NodeKindEnum = z.enum(['local', 'ssh']);
export type NodeKind = z.infer<typeof NodeKindEnum>;

/**
 * How an SSH node authenticates: a private key (optionally passphrase-protected)
 * or a username/password. The credential material itself is encrypted at rest
 * (never serialized to clients); only the method is exposed so the edit form can
 * show the right fields.
 */
export const SshAuthMethodEnum = z.enum(['key', 'password']);
export type SshAuthMethod = z.infer<typeof SshAuthMethodEnum>;

export const ConnectionStatusEnum = z.enum(['connected', 'connecting', 'disconnected', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusEnum>;

export const AgentTypeEnum = z.enum([
  'claude-code',
  'codex',
  'opencode',
  // Google Gemini CLI — launched over ACP (`--experimental-acp`) for structured
  // chat + status (permission/turn/usage). Permission flags map to --approval-mode /
  // --yolo. Hooks exist as a PTY-path fallback but ACP is the live transport.
  'gemini',
  // xAI Grok Build CLI (https://x.ai/cli, binary `grok`). Native PTY + lifecycle
  // hooks (~/.grok/hooks/flock.json). Does NOT speak ACP. Status from hooks;
  // no transcript → no Chat tab yet. Auth bootstrap: device-code when unauthed.
  'grok',
  // Additional CLI agents (launchable if installed; status via PTY activity —
  // no first-class transcript/hook integration yet):
  'aider', // Aider (pip) — `aider`
  'cursor-agent', // Cursor's headless agent CLI — `cursor-agent`
  'amp', // Sourcegraph Amp CLI — `amp`
  // A plain shell session — no agent program, just the node's default shell over
  // the PTY bridge (like SSHing in). Same infra as agent sessions; no hooks.
  'terminal',
  // A supervised long-running dev process (e.g. `npm run dev`): runs a configured
  // command that the node daemon AUTO-RESTARTS on exit. No agent program/hooks;
  // the command rides CreateSessionRequest.devCommand.
  'dev',
]);
export type AgentType = z.infer<typeof AgentTypeEnum>;

/**
 * The autonomy/permission level an agent is launched with (US-launch-modes).
 * Agent-agnostic; the orchestrator maps each to the right per-agent CLI flags:
 *   - `default`     the CLI's normal interactive prompting (safest).
 *   - `acceptEdits` auto-accept file edits (Claude acceptEdits / Codex full-auto).
 *   - `plan`        read-only planning, no writes.
 *   - `autonomous`  no prompts at all ("YOLO": Claude --dangerously-skip-permissions
 *                   / Codex bypass) — only sane on an isolated/sandboxed node.
 * Irrelevant for `terminal` (no agent program → no flags).
 */
export const SessionPermissionModeEnum = z.enum(['default', 'acceptEdits', 'plan', 'autonomous']);
export type SessionPermissionMode = z.infer<typeof SessionPermissionModeEnum>;

export const EventSourceEnum = z.enum(['hook', 'osc', 'pty', 'orchestrator']);
export type EventSource = z.infer<typeof EventSourceEnum>;

export const SecretKindEnum = z.enum(['ssh_key', 'hook_token', 'node_env', 'agentd_control']);
export type SecretKind = z.infer<typeof SecretKindEnum>;

export const AgentCapabilityScopeEnum = z.enum([
  'agents:list:project',
  'agents:read:project',
  'agents:send:project',
  'agents:spawn:project',
  'agents:terminate:project',
]);
export type AgentCapabilityScope = z.infer<typeof AgentCapabilityScopeEnum>;

/** Human-readable authority tiers; coding-tool autonomy remains a separate setting. */
export const AgentAuthorityEnum = z.enum([
  'callback_only',
  'observe',
  'collaborate',
  'delegate',
  'manage',
]);
export type AgentAuthority = z.infer<typeof AgentAuthorityEnum>;

const AUTHORITY_SCOPES: Record<AgentAuthority, readonly AgentCapabilityScope[]> = {
  callback_only: [],
  observe: ['agents:list:project', 'agents:read:project'],
  collaborate: ['agents:list:project', 'agents:read:project', 'agents:send:project'],
  delegate: [
    'agents:list:project',
    'agents:read:project',
    'agents:send:project',
    'agents:spawn:project',
  ],
  manage: [...AgentCapabilityScopeEnum.options],
};

export function agentAuthorityScopes(authority: AgentAuthority): AgentCapabilityScope[] {
  return [...AUTHORITY_SCOPES[authority]];
}

export function authorityAllows(maximum: AgentAuthority, requested: AgentAuthority): boolean {
  return (
    AgentAuthorityEnum.options.indexOf(requested) <= AgentAuthorityEnum.options.indexOf(maximum)
  );
}

/** Durable, server-owned project bounds for agent-to-agent orchestration. */
export const ProjectAgentPolicySchema = z
  .object({
    defaultAuthority: AgentAuthorityEnum,
    maxAuthority: AgentAuthorityEnum,
    maxConcurrentAgents: z.number().int().min(1).max(64),
    spawnRateLimitPerMinute: z.number().int().min(1).max(60),
    maxSendBytes: z.number().int().min(256).max(65536),
    maxReadMessages: z.number().int().min(1).max(500),
  })
  .refine((policy) => authorityAllows(policy.maxAuthority, policy.defaultAuthority), {
    message: 'default authority must not exceed maximum authority',
    path: ['defaultAuthority'],
  });
export type ProjectAgentPolicy = z.infer<typeof ProjectAgentPolicySchema>;

export const DEFAULT_PROJECT_AGENT_POLICY: ProjectAgentPolicy = Object.freeze({
  defaultAuthority: 'callback_only',
  maxAuthority: 'manage',
  maxConcurrentAgents: 12,
  spawnRateLimitPerMinute: 10,
  maxSendBytes: 16 * 1024,
  maxReadMessages: 100,
});

export const AuditActionEnum = z.enum([
  'login',
  'logout',
  'node_add',
  'node_update',
  'node_remove',
  'node_credential_rotate',
  'node_control_event',
  'agent_policy_event',
  'session_create',
  'session_terminate',
  'preview_create',
  'preview_revoke',
  'preview_forward_start',
  'preview_forward_stop',
  'preview_forward_expire',
  'preview_service_save',
  'preview_service_forget',
  'preview_settings_update',
  'preview_test',
  'secret_access',
  'owner_setup',
]);
export type AuditAction = z.infer<typeof AuditActionEnum>;

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

export const Uuid = z.string().uuid();
/** ISO-8601 timestamp string (the wire form for all `*_at` / `ts` fields). */
export const IsoTimestamp = z.string().datetime();

// ---------------------------------------------------------------------------
// Entities (spec §6)
// ---------------------------------------------------------------------------

/** users — never serializes `password_hash` to clients. */
export const UserSchema = z.object({
  id: Uuid,
  username: z.string().min(1),
  /** Optional human display name; null = use the username. */
  displayName: z.string().nullable(),
  createdAt: IsoTimestamp,
  lastLoginAt: IsoTimestamp.nullable(),
  isActive: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

/** nodes (spec §6). `sshKeyRef` references a row in `secrets`. */
export const NodeSchema = z.object({
  id: Uuid,
  name: z.string().min(1),
  kind: NodeKindEnum,
  host: z.string().nullable(),
  port: z.number().int().positive().nullable(),
  sshUser: z.string().nullable(),
  sshKeyRef: Uuid.nullable(),
  /** Auth method for ssh nodes ('key' | 'password'); null for local nodes. */
  sshAuthMethod: SshAuthMethodEnum.nullable(),
  /** Optional pool/group label for organizing the fleet; null = ungrouped. */
  pool: z.string().nullable(),
  connectionStatus: ConnectionStatusEnum,
  lastSeenAt: IsoTimestamp.nullable(),
  /** Null only during first-run boot before the installation owner exists. */
  createdBy: Uuid.nullable(),
  createdAt: IsoTimestamp,
});
export type Node = z.infer<typeof NodeSchema>;

/** projects (spec §6) — scoped by node. */
export const ProjectSchema = z.object({
  id: Uuid,
  nodeId: Uuid,
  name: z.string().min(1),
  workingDir: z.string().min(1),
  agentPolicy: ProjectAgentPolicySchema,
  createdAt: IsoTimestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * agent_sessions — THE single authoritative session record (spec §4.2/§6).
 *
 * Invariant (asserted in tests): one `id` (the session_id) names the tmux
 * session (`tmuxSessionName`), scopes the hook token (`hookTokenHash`), and
 * scopes the hook token (`hookTokenHash`). `status` here is the
 * write-behind MIRROR of the in-memory authoritative status (spec §6.6).
 */
export const SessionRecordSchema = z.object({
  id: Uuid,
  nodeId: Uuid,
  projectId: Uuid,
  agentType: AgentTypeEnum,
  tmuxSessionName: z.string().min(1),
  workingDir: z.string().min(1),
  /** Hash of the per-session hook token (NFR-SEC3); never the plaintext. */
  hookTokenHash: z.string().min(1),
  status: StatusEnum,
  statusDetail: z.string().nullable(),
  /** Free-text supervisor note about this session (what it's working on); null = none. */
  note: z.string().nullable(),
  /**
   * The autonomy level the agent was launched with (T18). Persisted so it
   * survives restarts and is visible to a supervisor (an `autonomous` agent is a
   * safety-relevant state) and so the session can be restarted as-is.
   */
  permissionMode: SessionPermissionModeEnum,
  /** Effective Shepherd agent-to-agent authority. Contains no credential material. */
  orchestrationAuthority: AgentAuthorityEnum,
  createdAt: IsoTimestamp,
  lastStatusAt: IsoTimestamp,
  createdBy: Uuid,
  closedAt: IsoTimestamp.nullable(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Browser-safe session view. Control-plane identity and capability material are
 * deliberately absent: the web never needs the daemon handle, hook-token hash,
 * or creating-user id. Keep this allowlist-shaped projection at
 * the shared contract boundary so adding an internal field cannot leak it
 * accidentally through a REST response.
 */
export const SessionSchema = SessionRecordSchema.omit({
  tmuxSessionName: true,
  hookTokenHash: true,
  createdBy: true,
});
export type Session = z.infer<typeof SessionSchema>;

/** Strip every internal-only field from a durable session record. */
export function toPublicSession(session: SessionRecord): Session {
  return SessionSchema.parse(session);
}

/** events — append-only, write-behind log (spec §6). */
export const EventSchema = z.object({
  id: Uuid,
  sessionId: Uuid,
  ts: IsoTimestamp,
  type: z.string().min(1),
  source: EventSourceEnum,
  /** Raw agent event payload as received (jsonb). */
  agentEventRaw: z.unknown().nullable(),
  mappedStatus: StatusEnum.nullable(),
  detail: z.string().nullable(),
});
export type Event = z.infer<typeof EventSchema>;

/** push_subscriptions (spec §6). */
export const PushSubscriptionSchema = z.object({
  id: Uuid,
  userId: Uuid,
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  createdAt: IsoTimestamp,
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

/** audit_log — append-only (FR-A3, spec §6). */
export const AuditEntrySchema = z.object({
  id: Uuid,
  ts: IsoTimestamp,
  userId: Uuid.nullable(),
  action: AuditActionEnum,
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** A coding-agent CLI detected on a node (agentd probes the node's PATH). */
export const NodeAgentInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  path: z.string(),
});
export type NodeAgentInfo = z.infer<typeof NodeAgentInfoSchema>;

/**
 * Live host metrics + detected agents for one node, gathered by flock-agentd
 * (CPU/mem/disk in bytes; load is the 1/5/15-minute averages). Not persisted —
 * fetched on demand for the node-info dialog + the bottom status bar.
 */
export const NodeInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  kernel: z.string(),
  cores: z.number(),
  uptimeSec: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  cpuPercent: z.number(),
  memTotal: z.number(),
  memUsed: z.number(),
  diskTotal: z.number(),
  diskUsed: z.number(),
  agents: z.array(NodeAgentInfoSchema),
  /** Per-session resource usage keyed by sessionId — resident memory (bytes) +
   *  CPU% (share of total host CPU since the last poll) — for attributing a node's
   *  RAM/CPU to specific sessions. Omitted by older daemons. */
  processes: z
    .record(z.string(), z.object({ rssBytes: z.number(), cpuPct: z.number() }))
    .optional(),
  control: z
    .object({
      mode: z.enum(['secure', 'insecure-development']),
      protocol: z.number().int().positive(),
      nodeId: z.string(),
      daemonVersion: z.string(),
      connections: z.number().int().nonnegative(),
      authFailures: z.number().int().nonnegative(),
      malformedFrames: z.number().int().nonnegative(),
      writeTimeouts: z.number().int().nonnegative(),
      droppedOutputBytes: z.number().int().nonnegative(),
      sessionsOpened: z.number().int().nonnegative(),
      sessionsClosed: z.number().int().nonnegative(),
      credentialRotations: z.number().int().nonnegative(),
    })
    .optional(),
  lifecycle: z
    .object({
      expectedDaemonVersion: z.string(),
      daemonCompatibility: AgentdCompatibilitySchema,
      upgrade: z
        .object({
          status: z.enum(['deferred', 'rolled_back']),
          installedVersion: z.string(),
          expectedVersion: z.string(),
          activeSessions: z.number().int().nonnegative(),
          message: z.string(),
          requirement: z.enum(['recommended', 'required']),
        })
        .nullable(),
    })
    .optional(),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;
