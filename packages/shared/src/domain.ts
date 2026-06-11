import { z } from 'zod';
import { StatusEnum } from './status.js';

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

export const RoleEnum = z.enum(['admin', 'member']);
export type Role = z.infer<typeof RoleEnum>;

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

export const ConnectionStatusEnum = z.enum([
  'connected',
  'connecting',
  'disconnected',
  'error',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusEnum>;

export const AgentTypeEnum = z.enum([
  'claude-code',
  'codex',
  'opencode',
  // Google Gemini CLI (T20). Launchable with permission flags; the PTY shows full
  // activity. Transcript-derived status granularity (thinking/idle) is not yet
  // parsed, so its dot reflects liveness rather than per-turn state.
  'gemini',
  // xAI Grok Build CLI (https://x.ai/cli, binary `grok`). Native auth (browser
  // OAuth / GROK_CODE_XAI_API_KEY). No documented transcript/hook format yet, so —
  // like gemini — its status is derived from PTY activity (liveness), not per-turn.
  'grok',
  // Additional CLI agents (launchable if installed on the node; status via PTY
  // activity like gemini/grok — no transcript/hook integration yet):
  'aider', // Aider (pip) — `aider`
  'cursor-agent', // Cursor's headless agent CLI — `cursor-agent`
  'amp', // Sourcegraph Amp CLI — `amp`
  'generic',
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
 * Irrelevant for `generic`/`terminal` (no agent program → no flags).
 */
export const SessionPermissionModeEnum = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'autonomous',
]);
export type SessionPermissionMode = z.infer<typeof SessionPermissionModeEnum>;

export const EventSourceEnum = z.enum(['hook', 'osc', 'pty', 'orchestrator']);
export type EventSource = z.infer<typeof EventSourceEnum>;

export const SecretKindEnum = z.enum(['ssh_key', 'hook_token', 'node_env']);
export type SecretKind = z.infer<typeof SecretKindEnum>;

export const AuditActionEnum = z.enum([
  'login',
  'logout',
  'node_add',
  'node_update',
  'node_remove',
  'session_create',
  'session_terminate',
  'browser_takeover',
  'browser_release',
  'secret_access',
  'user_create',
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
  role: RoleEnum,
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
  createdBy: Uuid,
  createdAt: IsoTimestamp,
});
export type Node = z.infer<typeof NodeSchema>;

/** projects (spec §6) — scoped by node. */
export const ProjectSchema = z.object({
  id: Uuid,
  nodeId: Uuid,
  name: z.string().min(1),
  workingDir: z.string().min(1),
  createdAt: IsoTimestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * agent_sessions — THE single authoritative session record (spec §4.2/§6).
 *
 * Invariant (asserted in tests): one `id` (the session_id) names the tmux
 * session (`tmuxSessionName`), scopes the hook token (`hookTokenHash`), and
 * binds the browser endpoint (`browserCdpEndpoint`). `status` here is the
 * write-behind MIRROR of the in-memory authoritative status (spec §6.6).
 */
export const SessionSchema = z.object({
  id: Uuid,
  nodeId: Uuid,
  projectId: Uuid,
  agentType: AgentTypeEnum,
  tmuxSessionName: z.string().min(1),
  workingDir: z.string().min(1),
  /** Opaque CDP ws URL including a GUID; null until a browser is started. */
  browserCdpEndpoint: z.string().url().nullable(),
  /** Hash of the per-session hook token (NFR-SEC3); never the plaintext. */
  hookTokenHash: z.string().min(1),
  status: StatusEnum,
  statusDetail: z.string().nullable(),
  /**
   * When set, this session runs in a dedicated git WORKTREE on this branch
   * (isolated parallel work, US-worktree). `workingDir` is the worktree path. The
   * branch is cleaned up on terminate; null = the session works in the project
   * dir directly.
   */
  worktreeBranch: z.string().nullable(),
  /** Pinned sessions sort to the top of the paddock tree (supervisor focus). */
  pinned: z.boolean(),
  /** Free-text supervisor note about this session (what it's working on); null = none. */
  note: z.string().nullable(),
  /** When the supervisor marked this session reviewed (ISO); null = not reviewed.
   *  Server-durable so "Ready to review" is consistent across devices + restarts. */
  reviewedAt: z.string().nullable(),
  /**
   * The autonomy level the agent was launched with (T18). Persisted so it
   * survives restarts and is visible to a supervisor (an `autonomous` agent is a
   * safety-relevant state) and so the session can be restarted as-is.
   */
  permissionMode: SessionPermissionModeEnum,
  createdAt: IsoTimestamp,
  lastStatusAt: IsoTimestamp,
  createdBy: Uuid,
  closedAt: IsoTimestamp.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

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
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;
