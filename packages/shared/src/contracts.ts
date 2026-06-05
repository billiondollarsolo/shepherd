import { z } from 'zod';
import { StatusEnum } from './status.js';
import {
  AgentTypeEnum,
  SessionPermissionModeEnum,
  AuditActionEnum,
  AuditEntrySchema,
  ConnectionStatusEnum,
  IsoTimestamp,
  NodeKindEnum,
  NodeSchema,
  SshAuthMethodEnum,
  ProjectSchema,
  RoleEnum,
  SessionSchema,
  UserSchema,
  Uuid,
} from './domain.js';

/**
 * REST + WebSocket contracts (spec §8), zod-validated, shared by both apps.
 *
 * Naming convention: `<Name>Request` / `<Name>Response` for REST bodies;
 * WS messages are tagged unions discriminated on `channel` (server→client) and
 * `op` (client→server subscribe/control).
 */

// ===========================================================================
// 8.1 REST
// ===========================================================================

// --- auth ------------------------------------------------------------------

/** POST /api/auth/setup — first-run admin creation (409 once an admin exists). */
export const SetupRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
});
export type SetupRequest = z.infer<typeof SetupRequest>;
export const SetupResponse = z.object({ user: UserSchema });
export type SetupResponse = z.infer<typeof SetupResponse>;

/** POST /api/auth/login — sets httpOnly session cookie. */
export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
export const LoginResponse = z.object({ user: UserSchema });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** GET /api/auth/me */
export const MeResponse = z.object({ user: UserSchema });
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * GET /api/auth/status — public first-run probe. `setupRequired` is true until
 * the initial admin exists, so the sign-in UI can show "create first admin"
 * vs. "sign in" without a destructive POST.
 */
export const AuthStatusResponse = z.object({ setupRequired: z.boolean() });
export type AuthStatusResponse = z.infer<typeof AuthStatusResponse>;

// --- users (admin) ---------------------------------------------------------

/** POST /api/users — invite/create. */
export const CreateUserRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
  role: RoleEnum,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;
export const CreateUserResponse = z.object({ user: UserSchema });
export type CreateUserResponse = z.infer<typeof CreateUserResponse>;

/** GET /api/users */
export const ListUsersResponse = z.object({ users: z.array(UserSchema) });
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;

// --- nodes -----------------------------------------------------------------

/** POST /api/nodes — register a local or SSH node. */
export const CreateNodeRequest = z
  .object({
    name: z.string().min(1),
    kind: NodeKindEnum,
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    sshUser: z.string().min(1).optional(),
    /** Auth method for ssh nodes (defaults to 'key' when omitted). */
    sshAuthMethod: SshAuthMethodEnum.optional(),
    /** Plaintext private key; orchestrator encrypts at rest, never echoes it. */
    sshPrivateKey: z.string().min(1).optional(),
    /** Optional passphrase for an encrypted private key (encrypted at rest). */
    sshPassphrase: z.string().min(1).optional(),
    /** Plaintext password for password auth; encrypted at rest, never echoed. */
    sshPassword: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind !== 'ssh') return;
    // host + user are always required for ssh.
    for (const f of ['host', 'sshUser'] as const) {
      if (!val[f]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: `${f} is required for ssh nodes` });
      }
    }
    // The credential required depends on the auth method (key is the default).
    if (val.sshAuthMethod === 'password') {
      if (!val.sshPassword) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sshPassword'], message: 'sshPassword is required for password auth' });
      }
    } else if (!val.sshPrivateKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sshPrivateKey'], message: 'sshPrivateKey is required for key auth' });
    }
  });
export type CreateNodeRequest = z.infer<typeof CreateNodeRequest>;

/**
 * PATCH /api/nodes/:id — edit a node. Every field is optional (a partial update);
 * `kind` is immutable (delete + re-add to change it). Credential fields left out
 * KEEP the existing value (SSH clients behave the same), so the form can show
 * blank "leave to keep" inputs. Switching `sshAuthMethod` to a method with no
 * stored credential requires sending that credential.
 */
export const UpdateNodeRequest = z
  .object({
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    sshUser: z.string().min(1).optional(),
    sshAuthMethod: SshAuthMethodEnum.optional(),
    sshPrivateKey: z.string().min(1).optional(),
    sshPassphrase: z.string().min(1).optional(),
    sshPassword: z.string().min(1).optional(),
  })
  .strict();
export type UpdateNodeRequest = z.infer<typeof UpdateNodeRequest>;

export const NodeResponse = z.object({ node: NodeSchema });
export type NodeResponse = z.infer<typeof NodeResponse>;
export const ListNodesResponse = z.object({ nodes: z.array(NodeSchema) });
export type ListNodesResponse = z.infer<typeof ListNodesResponse>;

/** GET /api/nodes/:id/status */
export const NodeStatusResponse = z.object({
  id: Uuid,
  connectionStatus: ConnectionStatusEnum,
  lastSeenAt: IsoTimestamp.nullable(),
});
export type NodeStatusResponse = z.infer<typeof NodeStatusResponse>;

// --- node filesystem browse (pick a working dir without typing it) ----------

/**
 * GET /api/nodes/:id/fs?path=... — list directories under `path` ON the node, so
 * the UI can offer a path browser instead of a blind text field (works for local
 * AND remote/ssh nodes, over that node's transport). Directories only (you pick a
 * working dir / repo root). `path` defaults to the node's home dir when omitted.
 */
export const ListNodeDirQuery = z.object({ path: z.string().optional() });
export type ListNodeDirQuery = z.infer<typeof ListNodeDirQuery>;

/** A single directory entry returned by the path browser. */
export const NodeDirEntrySchema = z.object({
  name: z.string(),
  /** Absolute path of the entry on the node. */
  path: z.string(),
});
export type NodeDirEntry = z.infer<typeof NodeDirEntrySchema>;

/**
 * GET /api/nodes/:id/fs response. `path` is the absolute, resolved directory
 * being listed; `parent` is its parent (null at filesystem root); `entries` are
 * the child directories (sorted, dotfiles excluded by default).
 */
export const ListNodeDirResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(NodeDirEntrySchema),
});
export type ListNodeDirResponse = z.infer<typeof ListNodeDirResponse>;

// --- node file tree + read/write (VS Code–style file browser) ---------------

/** Whether a tree entry is a directory or a regular file. */
export const NodeFsKind = z.enum(['dir', 'file']);
export type NodeFsKind = z.infer<typeof NodeFsKind>;

/** One entry (dir OR file) from the file-tree listing. */
export const NodeFsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: NodeFsKind,
});
export type NodeFsEntry = z.infer<typeof NodeFsEntry>;

/** GET /api/nodes/:id/fs/tree?path=... — dirs AND files under `path` (one level). */
export const NodeFsTreeResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(NodeFsEntry),
});
export type NodeFsTreeResponse = z.infer<typeof NodeFsTreeResponse>;

/**
 * GET /api/nodes/:id/fs/file?path=... — read a file's bytes (base64, capped).
 * `truncated` is true when the file was larger than the read cap. The client
 * decodes `contentBase64`; if it isn't valid UTF-8 it renders as binary.
 */
export const NodeFileReadResponse = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  contentBase64: z.string(),
});
export type NodeFileReadResponse = z.infer<typeof NodeFileReadResponse>;

/**
 * PUT /api/nodes/:id/fs/file — write bytes to `path` (base64). Serves both the
 * in-browser editor (save) and drag-and-drop upload. The parent dir must exist.
 */
export const NodeFileWriteRequest = z.object({
  path: z.string().min(1),
  contentBase64: z.string(),
});
export type NodeFileWriteRequest = z.infer<typeof NodeFileWriteRequest>;

export const NodeFileWriteResponse = z.object({ ok: z.literal(true), path: z.string() });
export type NodeFileWriteResponse = z.infer<typeof NodeFileWriteResponse>;

/**
 * POST /api/nodes/:id/fs/mkdir — create ONE new directory `name` inside the
 * existing `parent` dir (the path picker's "New folder"). `name` is a single path
 * component — no separators or `.`/`..` (enforced server-side too) so it can't
 * escape `parent`. Like the file write, this is a node filesystem mutation →
 * admin-gated.
 */
export const NodeMakeDirRequest = z.object({
  parent: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !n.includes('/') && n !== '.' && n !== '..' && n.trim() === n, {
      message: 'name must be a single path component (no "/", "." or "..")',
    }),
});
export type NodeMakeDirRequest = z.infer<typeof NodeMakeDirRequest>;

export const NodeMakeDirResponse = z.object({ path: z.string() });
export type NodeMakeDirResponse = z.infer<typeof NodeMakeDirResponse>;

// --- projects --------------------------------------------------------------

/** GET /api/projects?nodeId=... */
export const ListProjectsQuery = z.object({ nodeId: Uuid.optional() });
export type ListProjectsQuery = z.infer<typeof ListProjectsQuery>;
export const ListProjectsResponse = z.object({ projects: z.array(ProjectSchema) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;

/** POST /api/projects */
export const CreateProjectRequest = z.object({
  nodeId: Uuid,
  name: z.string().min(1),
  workingDir: z.string().min(1),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export const ProjectResponse = z.object({ project: ProjectSchema });
export type ProjectResponse = z.infer<typeof ProjectResponse>;

// --- sessions --------------------------------------------------------------

/** GET /api/sessions?projectId=... */
export const ListSessionsQuery = z.object({
  nodeId: Uuid.optional(),
  projectId: Uuid.optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;
export const ListSessionsResponse = z.object({ sessions: z.array(SessionSchema) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

/** POST /api/sessions — create a session (allocates tmux name + hook token). */
export const CreateSessionRequest = z.object({
  projectId: Uuid,
  agentType: AgentTypeEnum,
  /** Optional override; defaults to the project's working_dir. */
  workingDir: z.string().min(1).optional(),
  /**
   * Autonomy level to launch the agent with (maps to per-agent CLI flags).
   * Defaults to `default` (interactive prompting) when omitted.
   */
  permissionMode: SessionPermissionModeEnum.optional(),
  /**
   * Run this session in a dedicated git worktree (isolated branch) so multiple
   * agents can work the same repo in parallel without colliding. Requires the
   * project dir to be a git repo. Optional branch name override (sanitized;
   * defaults to `flock/<session-short>`).
   */
  worktree: z.boolean().optional(),
  worktreeBranch: z.string().min(1).max(120).optional(),
  /**
   * For an agentType of `dev` ONLY: the shell command to run as a supervised,
   * auto-restarting dev process (e.g. `npm run dev`). Required when agentType is
   * `dev`, ignored otherwise. Run via the node's shell (`sh -lc`).
   */
  devCommand: z.string().min(1).max(2000).optional(),
}).superRefine((val, ctx) => {
  if (val.agentType === 'dev' && !val.devCommand?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['devCommand'],
      message: 'devCommand is required for a dev session.',
    });
  }
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/**
 * Session-create response. The plaintext hook token is returned EXACTLY ONCE
 * here (only its hash is stored, per NFR-SEC3) so it can be injected into the
 * session's hook config; it is never returned by any GET.
 */
export const CreateSessionResponse = z.object({
  session: SessionSchema,
  hookToken: z.string().min(1),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

/** GET /api/sessions/:id */
export const SessionResponse = z.object({ session: SessionSchema });
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Path param for the session-scoped routes (`/api/sessions/:id`). */
export const SessionIdParams = z.object({ id: Uuid });
export type SessionIdParams = z.infer<typeof SessionIdParams>;

/**
 * PATCH /api/sessions/:id — update supervisor-facing session metadata: pin it to
 * the top of the paddock tree and/or set a free-text note. Both optional; at
 * least one should be present. `note: null` clears the note. Does NOT touch the
 * live status / process — purely cosmetic registry fields. Returns the session.
 */
export const UpdateSessionRequest = z
  .object({
    pinned: z.boolean().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.pinned !== undefined || v.note !== undefined, {
    message: 'provide at least one of pinned or note.',
  });
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/**
 * DELETE /api/sessions/:id — terminate (US-13, FR-S5). The orchestrator kills
 * the tmux session + any per-session browser harness, marks the authoritative
 * record closed (sets `closed_at`), and writes a `session_terminate` audit row.
 * The response echoes the closed session id and the close timestamp.
 */
export const TerminateSessionResponse = z.object({
  sessionId: Uuid,
  /** True once the record is closed (idempotent: also true if already closed). */
  terminated: z.literal(true),
  /** When the record was/is marked closed (ISO-8601). */
  closedAt: IsoTimestamp,
});
export type TerminateSessionResponse = z.infer<typeof TerminateSessionResponse>;

// --- diff ------------------------------------------------------------------

/** GET /api/sessions/:id/diff — read-only git diff of the working dir. */
export const DiffResponse = z.object({
  sessionId: Uuid,
  /** Unified `git diff` text (may be empty when the tree is clean). */
  diff: z.string(),
  generatedAt: IsoTimestamp,
});
export type DiffResponse = z.infer<typeof DiffResponse>;

/**
 * Query params for GET /api/sessions/:id/diff. `staged` selects which side to
 * show: omitted → the COMBINED working-tree-vs-HEAD diff (everything the agent
 * touched); `"true"` → only the staged (index-vs-HEAD) diff; `"false"` → only
 * the unstaged (worktree-vs-index) diff. `path` scopes the diff to one file (the
 * per-file preview the Source Control panel opens on click). Both are strings
 * because they arrive on the query string; the route narrows `staged`.
 */
export const DiffQuery = z.object({
  staged: z.enum(['true', 'false']).optional(),
  path: z.string().min(1).optional(),
});
export type DiffQuery = z.infer<typeof DiffQuery>;

// --- git source control (US-33.1: stage / commit / push) -------------------

/** Coarse change kind for a changed file, for the UI's per-row badge. */
export const GitFileChangeKind = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'unmerged',
]);
export type GitFileChangeKind = z.infer<typeof GitFileChangeKind>;

/**
 * One changed file from `git status --porcelain=v2`. `indexStatus` /
 * `worktreeStatus` are the raw porcelain XY codes (`.` = unmodified); `staged` /
 * `unstaged` are the derived booleans the panel groups by; `origPath` is set for
 * renames/copies (the source path).
 */
export const GitFileStatus = z.object({
  path: z.string().min(1),
  origPath: z.string().nullable(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  kind: GitFileChangeKind,
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

/** GET /api/sessions/:id/git/status — the Source Control file list + branch. */
export const GitStatusResponse = z.object({
  sessionId: Uuid,
  /** Current branch name, or null when detached. */
  branch: z.string().nullable(),
  /** Upstream tracking ref (e.g. `origin/main`), or null when none. */
  upstream: z.string().nullable(),
  /** Commits ahead of the upstream (0 when no upstream). */
  ahead: z.number().int().nonnegative(),
  /** Commits behind the upstream (0 when no upstream). */
  behind: z.number().int().nonnegative(),
  /** False for a freshly `git init`'d repo with no commits (unborn HEAD). */
  hasHead: z.boolean(),
  files: z.array(GitFileStatus),
  generatedAt: IsoTimestamp,
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

/**
 * POST /api/sessions/:id/git/(stage|unstage). An EMPTY `paths` array means "all
 * changes" (stage/unstage everything), matching the panel's bulk actions.
 */
export const GitStageRequest = z.object({
  paths: z.array(z.string().min(1)).default([]),
});
export type GitStageRequest = z.infer<typeof GitStageRequest>;

/** POST /api/sessions/:id/git/commit — commits the staged changes. */
export const GitCommitRequest = z.object({
  message: z.string().min(1),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

export const GitCommitResponse = z.object({
  sessionId: Uuid,
  /** False when there was nothing staged to commit (a soft no-op, not an error). */
  committed: z.boolean(),
  /** Short sha of the new commit when `committed`, else null. */
  sha: z.string().nullable(),
  /** One-line human detail (the commit summary, or why nothing happened). */
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitCommitResponse = z.infer<typeof GitCommitResponse>;

/**
 * POST /api/sessions/:id/git/push response. Push runs with the NODE's own git
 * credentials (Flock's SSH connection is to the node, not to the git remote), so
 * `detail` carries git's output verbatim for the user to read.
 */
export const GitPushResponse = z.object({
  sessionId: Uuid,
  pushed: z.literal(true),
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitPushResponse = z.infer<typeof GitPushResponse>;

// --- agent plan / todo (US-34 Plan artifact) -------------------------------

/** A plan/todo item's lifecycle state (maps from Claude Code TodoWrite status). */
export const PlanItemStatus = z.enum(['pending', 'in_progress', 'completed']);
export type PlanItemStatus = z.infer<typeof PlanItemStatus>;

/** One step of the agent's current plan/todo list. */
export const PlanItem = z.object({
  content: z.string().min(1),
  status: PlanItemStatus,
});
export type PlanItem = z.infer<typeof PlanItem>;

/**
 * The agent's current plan — the latest TodoWrite snapshot (US-34 Plan artifact).
 * `updatedAt` is the event timestamp the snapshot was captured at.
 */
export const SessionPlan = z.object({
  items: z.array(PlanItem),
  updatedAt: IsoTimestamp,
});
export type SessionPlan = z.infer<typeof SessionPlan>;

/** GET /api/sessions/:id/plan — null when the agent has not emitted a plan. */
export const SessionPlanResponse = z.object({ plan: SessionPlan.nullable() });
export type SessionPlanResponse = z.infer<typeof SessionPlanResponse>;

// --- push ------------------------------------------------------------------

/** POST /api/push/subscribe (mirrors the W3C PushSubscription JSON shape). */
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;
export const PushSubscribeResponse = z.object({ ok: z.literal(true) });
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

/** DELETE /api/push/subscribe */
export const PushUnsubscribeRequest = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequest>;

// --- browser control -------------------------------------------------------

/** POST /api/sessions/:id/browser/(start|stop|takeover|release) */
export const BrowserActionEnum = z.enum(['start', 'stop', 'takeover', 'release']);
export type BrowserAction = z.infer<typeof BrowserActionEnum>;

export const BrowserControlResponse = z.object({
  sessionId: Uuid,
  action: BrowserActionEnum,
  /** Opaque CDP ws endpoint when a browser is running, else null. */
  browserCdpEndpoint: z.string().url().nullable(),
  /** Whether THIS client now holds the single input-control lock. */
  inControl: z.boolean(),
});
export type BrowserControlResponse = z.infer<typeof BrowserControlResponse>;

// --- audit (US-40, FR-A3) --------------------------------------------------

/** Hard ceiling on how many audit rows one `GET /api/audit` page may return. */
export const AUDIT_MAX_LIMIT = 500;
/** Default page size when the caller does not specify `limit`. */
export const AUDIT_DEFAULT_LIMIT = 100;

/**
 * GET /api/audit query (admin-only, US-40). Supports newest-first pagination and
 * optional narrowing by `action` and/or acting `userId`, so an admin can answer
 * "show me every login" or "what did user X do". All fields are optional; the
 * route applies {@link AUDIT_DEFAULT_LIMIT} / {@link AUDIT_MAX_LIMIT}.
 *
 * `z.coerce` is used for `limit`/`offset` because query-string values arrive as
 * strings; this keeps the same schema usable for both URL parsing and tests.
 */
export const ListAuditQuery = z.object({
  /** Filter to a single audit action (e.g. `login`, `node_remove`). */
  action: AuditActionEnum.optional(),
  /** Filter to rows attributed to one acting user. */
  userId: Uuid.optional(),
  /** Page size (1..AUDIT_MAX_LIMIT); defaults to AUDIT_DEFAULT_LIMIT. */
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).optional(),
  /** Number of rows to skip (newest-first); defaults to 0. */
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListAuditQuery = z.infer<typeof ListAuditQuery>;

/**
 * GET /api/audit response (admin-only, US-40). `entries` are ordered newest-first
 * (descending `ts`). The append-only audit log is read off the live status path
 * (spec §6.6); this is a durable-store read, never the in-memory status map.
 */
export const ListAuditResponse = z.object({ entries: z.array(AuditEntrySchema) });
export type ListAuditResponse = z.infer<typeof ListAuditResponse>;

// --- errors ----------------------------------------------------------------

/** Uniform error envelope for non-2xx REST responses. */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ===========================================================================
// 8.2 WebSocket (one authed socket, multiplexed)
// ===========================================================================

/**
 * Live per-session agent telemetry that RIDES the status fan-out (no DB read) so
 * the paddock's token/tool/model/context%/cost gauges update over the WebSocket
 * instead of a fixed-interval poll. All fields optional — the daemon omits
 * unchanged ones, and a session with no transcript telemetry carries none.
 */
export const AgentTelemetry = z.object({
  tokens: z.number().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  contextPct: z.number().optional(),
  /** Raw context-window occupancy + limit, so the UI can show "120k / 200k", not
   *  just a percent. Limit is exact when the agent reports it, else the model table. */
  contextTokens: z.number().optional(),
  contextLimit: z.number().optional(),
  costUsd: z.number().optional(),
});
export type AgentTelemetry = z.infer<typeof AgentTelemetry>;

/**
 * The `status` channel payload — fanned out on every transition (spec §8.2).
 * This is the live-path message; it carries NO data that requires a DB read.
 * `meta` is optional live telemetry (US — polling→WS): present on agent frames,
 * absent on plain transitions (OSC fallback, boot restore, lifecycle).
 */
export const StatusUpdateMessage = z.object({
  channel: z.literal('status'),
  sessionId: Uuid,
  status: StatusEnum,
  detail: z.string().nullable(),
  ts: IsoTimestamp,
  meta: AgentTelemetry.optional(),
});
export type StatusUpdateMessage = z.infer<typeof StatusUpdateMessage>;

/** The `nodes` channel payload — node connection-status changes. */
export const NodeUpdateMessage = z.object({
  channel: z.literal('nodes'),
  nodeId: Uuid,
  connectionStatus: ConnectionStatusEnum,
  lastSeenAt: IsoTimestamp.nullable(),
  ts: IsoTimestamp,
});
export type NodeUpdateMessage = z.infer<typeof NodeUpdateMessage>;

/**
 * Control envelope for `pty:<sessionId>` data. The binary PTY bytes ride the
 * socket as binary frames; this JSON envelope carries non-binary control
 * (resize, subscribe ack) for the same logical channel.
 */
export const PtyControlMessage = z.object({
  channel: z.literal('pty'),
  sessionId: Uuid,
  // `exited` = the PTY's process (the agent / shell) ended and the tmux session
  // is gone — TERMINAL, not a transient drop, so the client must NOT reconnect.
  op: z.enum(['attached', 'resize', 'detached', 'exited']),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  /** Process exit code on `exited` (null when killed by a signal). */
  exitCode: z.number().int().nullable().optional(),
  /** Terminating signal on `exited`, if any. */
  signal: z.string().nullable().optional(),
});
export type PtyControlMessage = z.infer<typeof PtyControlMessage>;

/** Screencast control/metadata for `screencast:<sessionId>` (frames are binary). */
export const ScreencastControlMessage = z.object({
  channel: z.literal('screencast'),
  sessionId: Uuid,
  op: z.enum(['started', 'stopped', 'in_control', 'released']),
  /** JPEG quality 0..100 when applicable. */
  quality: z.number().int().min(0).max(100).optional(),
});
export type ScreencastControlMessage = z.infer<typeof ScreencastControlMessage>;

/** Server→client message union (JSON frames). */
export const ServerMessage = z.discriminatedUnion('channel', [
  StatusUpdateMessage,
  NodeUpdateMessage,
  PtyControlMessage,
  ScreencastControlMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Client→server control messages: subscribe/unsubscribe to channels and
 * forward PTY resize / browser input intents.
 */
export const ClientSubscribeMessage = z.object({
  op: z.literal('subscribe'),
  channel: z.enum(['status', 'nodes', 'pty', 'screencast']),
  /** Required for the per-session channels (pty/screencast). */
  sessionId: Uuid.optional(),
});
export type ClientSubscribeMessage = z.infer<typeof ClientSubscribeMessage>;

export const ClientUnsubscribeMessage = z.object({
  op: z.literal('unsubscribe'),
  channel: z.enum(['status', 'nodes', 'pty', 'screencast']),
  sessionId: Uuid.optional(),
});
export type ClientUnsubscribeMessage = z.infer<typeof ClientUnsubscribeMessage>;

export const ClientPtyResizeMessage = z.object({
  op: z.literal('pty:resize'),
  sessionId: Uuid,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type ClientPtyResizeMessage = z.infer<typeof ClientPtyResizeMessage>;

export const ClientScreencastQualityMessage = z.object({
  op: z.literal('screencast:quality'),
  sessionId: Uuid,
  quality: z.number().int().min(0).max(100),
});
export type ClientScreencastQualityMessage = z.infer<
  typeof ClientScreencastQualityMessage
>;

export const ClientMessage = z.discriminatedUnion('op', [
  ClientSubscribeMessage,
  ClientUnsubscribeMessage,
  ClientPtyResizeMessage,
  ClientScreencastQualityMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
