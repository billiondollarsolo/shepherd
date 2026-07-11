/**
 * Flock — Postgres schema (Drizzle ORM), spec §6 data model.
 *
 * Postgres is the durable SYSTEM OF RECORD (users, nodes, projects, session
 * registry/history, events, push subs, audit, secrets). It is NEVER on the live
 * status path — that is an in-memory map fanned out over WebSocket (spec §6.6,
 * NFR-PERF1). The `agent_sessions.status` column is a write-behind MIRROR of the
 * in-memory authoritative status; the event log is written asynchronously.
 *
 * Single authoritative session record (spec §4.2 invariant): one
 * `agent_sessions` row — its `id` IS the session_id — threads together the tmux
 * session name (`tmux_session_name`), the per-session hook token
 * (`hook_token_hash`), and the browser CDP endpoint (`browser_cdp_endpoint`).
 *
 * Column names mirror the shared `@flock/shared` domain contract (Session,
 * Node, etc.) and the spec §6 table list; the StatusEnum and every value enum
 * come from `@flock/shared` so they are never duplicated.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Enum value tuples for Drizzle `text({ enum })` columns.
 *
 * The SINGLE SOURCE OF TRUTH for every value set is `@flock/shared` (its zod
 * enums / the StatusEnum). These literals MUST stay in lock-step with that
 * package — `schema.test.ts` imports the shared enums and asserts EXACT equality
 * (it fails CI if any value drifts). We declare the literals here rather than
 * importing `@flock/shared` at module scope because `drizzle-kit generate`
 * bundles this file via CommonJS and cannot traverse the shared package's
 * ESM-only `exports` map; the test is the guardrail that keeps them in sync.
 */
type EnumTuple = [string, ...string[]];

const STATUS_VALUES: EnumTuple = [
  'starting',
  'running',
  'awaiting_input',
  'idle',
  'done',
  'error',
  'disconnected',
];
const ROLE_VALUES: EnumTuple = ['admin', 'member'];
const NODE_KIND_VALUES: EnumTuple = ['local', 'ssh'];
const CONNECTION_STATUS_VALUES: EnumTuple = ['connected', 'connecting', 'disconnected', 'error'];
const AGENT_TYPE_VALUES: EnumTuple = [
  'claude-code',
  'codex',
  'opencode',
  'gemini',
  'grok',
  'aider',
  'cursor-agent',
  'amp',
  'generic',
  'terminal',
  'dev',
];
// T18: persisted agent autonomy level (mirrors shared SessionPermissionModeEnum).
const PERMISSION_MODE_VALUES: EnumTuple = ['default', 'acceptEdits', 'plan', 'autonomous'];
const EVENT_SOURCE_VALUES: EnumTuple = ['hook', 'osc', 'pty', 'orchestrator'];
// Mirrors shared SshAuthMethodEnum (named so the enum-drift guard can assert it).
const SSH_AUTH_METHOD_VALUES: EnumTuple = ['key', 'password'];
const SECRET_KIND_VALUES: EnumTuple = ['ssh_key', 'hook_token', 'node_env', 'agentd_control'];
const AUDIT_ACTION_VALUES: EnumTuple = [
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
];

/** Postgres `bytea` column (secret ciphertext is binary; spec §6 secrets). */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/** Reusable column factories. */
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// users — operator accounts (spec §6: username, password_hash argon2id, role)
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  /** Optional human display name (e.g. "Mike Johnson"); drives the avatar
   *  initials + greeting. Null = fall back to the username. */
  displayName: text('display_name'),
  /** argon2id hash; never plaintext, never serialized to clients. */
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ROLE_VALUES }).notNull(),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
});

// ---------------------------------------------------------------------------
// sessions_auth — web login sessions; the httpOnly cookie holds `id` (spec §6)
// ---------------------------------------------------------------------------
export const sessionsAuth = pgTable(
  'sessions_auth',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byUser: index('sessions_auth_user_id_idx').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// secrets — encrypted at rest (spec §6: kind, ciphertext bytea, nonce, key_version)
// Declared before `nodes` because nodes.ssh_key_ref FKs into it.
// ---------------------------------------------------------------------------
export const secrets = pgTable('secrets', {
  id: id(),
  kind: text('kind', { enum: SECRET_KIND_VALUES }).notNull(),
  /** Ciphertext only — never plaintext (NFR-SEC2). */
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  /** Enables key rotation: old ciphertext decrypts with its original key. */
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// nodes — execution targets (spec §6: kind local|ssh, ssh_key_ref FK secrets)
// ---------------------------------------------------------------------------
export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: NODE_KIND_VALUES }).notNull(),
    host: text('host'),
    port: integer('port'),
    sshUser: text('ssh_user'),
    // The encrypted SSH credential bundle (private key + passphrase, OR password)
    // lives in this `secrets` row as an encrypted JSON envelope; `sshAuthMethod`
    // decides which field the connector uses.
    sshKeyRef: uuid('ssh_key_ref').references(() => secrets.id, {
      onDelete: 'set null',
    }),
    // 'key' | 'password' — how this ssh node authenticates. Null for local nodes
    // (and legacy rows, which the connector treats as 'key').
    sshAuthMethod: text('ssh_auth_method', { enum: SSH_AUTH_METHOD_VALUES }),
    // #3a per-node env: an encrypted JSON envelope ({KEY:value,…}) in `secrets`,
    // merged (under) the per-session launch env for every agent on this node.
    // Null = no node-level env. set-null on secret delete (env just clears).
    envRef: uuid('env_ref').references(() => secrets.id, { onDelete: 'set null' }),
    // Unique node-control credential, encrypted through the same keyring as SSH
    // material. This column is internal and is never mapped to browser DTOs.
    agentdCredentialRef: uuid('agentd_credential_ref').references(() => secrets.id, {
      onDelete: 'set null',
    }),
    // #3c node pools: an optional free-text group label (e.g. "gpu", "us-east")
    // for organizing the fleet + scoping opt-in auto-placement. Null = ungrouped.
    pool: text('pool'),
    // T7: pinned SSH host-key fingerprint ("SHA256:..."). Null until the first
    // successful connect (trust-on-first-use); thereafter every reconnect must
    // present the same key or the connection is rejected (MITM defence).
    sshHostKey: text('ssh_host_key'),
    connectionStatus: text('connection_status', {
      enum: CONNECTION_STATUS_VALUES,
    }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => ({
    bySshKeyRef: index('nodes_ssh_key_ref_idx').on(t.sshKeyRef),
    byAgentdCredentialRef: index('nodes_agentd_credential_ref_idx').on(t.agentdCredentialRef),
  }),
);

// ---------------------------------------------------------------------------
// projects — scoped by node (spec §6: working_dir)
// ---------------------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: id(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    workingDir: text('working_dir').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    byNode: index('projects_node_id_idx').on(t.nodeId),
  }),
);

// ---------------------------------------------------------------------------
// agent_sessions — THE single authoritative session record (spec §4.2/§6).
//
// One `id` (== session_id) threads together:
//   - tmux session name      (tmux_session_name)
//   - per-session hook token  (hook_token_hash, unique)
//   - browser CDP endpoint    (browser_cdp_endpoint, opaque ws URL w/ GUID)
//
// `status` is the write-behind MIRROR of the in-memory authoritative status.
// ---------------------------------------------------------------------------
export const agentSessions = pgTable(
  'agent_sessions',
  {
    /** The session_id. This single value is the identity of the session. */
    id: id(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** claude-code | codex | opencode | generic | terminal | dev */
    agentType: text('agent_type', { enum: AGENT_TYPE_VALUES }).notNull(),
    tmuxSessionName: text('tmux_session_name').notNull(),
    workingDir: text('working_dir').notNull(),
    /** Opaque CDP ws URL incl. GUID; null until a browser is started. */
    browserCdpEndpoint: text('browser_cdp_endpoint'),
    /** Hash of the per-session hook token (NFR-SEC3); never plaintext. Unique. */
    hookTokenHash: text('hook_token_hash').notNull().unique(),
    /** Write-behind mirror of the in-memory authoritative status (§6.6). */
    status: text('status', { enum: STATUS_VALUES }).notNull(),
    statusDetail: text('status_detail'),
    /** Supervisor pinned this session to the top of the paddock tree. */
    pinned: boolean('pinned').notNull().default(false),
    /** Free-text supervisor note about this session; null = none. */
    note: text('note'),
    /** Collaboration lineage: the session that spawned/handed off to this one
     *  (durable teams graph; rehydrates the spatial graph on boot). No FK — a
     *  missing parent just drops the edge. */
    parentSessionId: uuid('parent_session_id'),
    /** Server-durable "reviewed" marker (closes the supervision loop across
     *  devices/restarts; was localStorage). Null = not reviewed. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    /** T18: the autonomy level the agent was launched with (restart-as-is + UI badge). */
    permissionMode: text('permission_mode', { enum: PERMISSION_MODE_VALUES })
      .notNull()
      .default('default'),
    createdAt: createdAt(),
    lastStatusAt: timestamp('last_status_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    byNode: index('agent_sessions_node_id_idx').on(t.nodeId),
    byProject: index('agent_sessions_project_id_idx').on(t.projectId),
    byStatus: index('agent_sessions_status_idx').on(t.status),
    // Teams graph: spawnEdges() scans rows WHERE parent_session_id IS NOT NULL.
    byParent: index('agent_sessions_parent_session_id_idx').on(t.parentSessionId),
  }),
);

// ---------------------------------------------------------------------------
// agent_capabilities — opaque, hashed, revocable agent orchestration authority.
// Callback-only hook credentials remain on agent_sessions and cannot authorize
// these scopes. Browser responses expose neither tokens nor hashes.
// ---------------------------------------------------------------------------
export const agentCapabilities = pgTable(
  'agent_capabilities',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    bySession: index('agent_capabilities_session_id_idx').on(t.sessionId),
    byProject: index('agent_capabilities_project_id_idx').on(t.projectId),
  }),
);

// ---------------------------------------------------------------------------
// events — append-only, WRITE-BEHIND log (spec §6). Indexed by (session_id, seq).
// ---------------------------------------------------------------------------
export const events = pgTable(
  'events',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    /** Monotonic per-table sequence — gives a stable append order. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    type: text('type').notNull(),
    /** hook | osc | pty | orchestrator */
    source: text('source', { enum: EVENT_SOURCE_VALUES }).notNull(),
    /** Raw agent event payload as received. */
    agentEventRaw: jsonb('agent_event_raw'),
    status: text('mapped_status', { enum: STATUS_VALUES }),
    detail: text('detail'),
  },
  (t) => ({
    bySessionSeq: index('events_session_id_seq_idx').on(t.sessionId, t.seq),
    bySessionTs: index('events_session_id_ts_idx').on(t.sessionId, t.ts),
  }),
);

// ---------------------------------------------------------------------------
// push_subscriptions — Web Push endpoints (spec §6)
// ---------------------------------------------------------------------------
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    byUser: index('push_subscriptions_user_id_idx').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// audit_log — append-only (FR-A3, spec §6)
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action', { enum: AUDIT_ACTION_VALUES }).notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    detail: text('detail'),
  },
  (t) => ({
    byUser: index('audit_log_user_id_idx').on(t.userId),
    byTs: index('audit_log_ts_idx').on(t.ts),
  }),
);

// ---------------------------------------------------------------------------
// project_pens — durable per-user project supervision layouts
// ---------------------------------------------------------------------------
export const projectPens = pgTable(
  'project_pens',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    document: jsonb('document').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.projectId] }),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export type SessionAuthRow = typeof sessionsAuth.$inferSelect;
export type NewSessionAuthRow = typeof sessionsAuth.$inferInsert;

export type NodeRow = typeof nodes.$inferSelect;
export type NewNodeRow = typeof nodes.$inferInsert;

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type SecretRow = typeof secrets.$inferSelect;
export type NewSecretRow = typeof secrets.$inferInsert;
export type AgentCapabilityRow = typeof agentCapabilities.$inferSelect;
export type NewAgentCapabilityRow = typeof agentCapabilities.$inferInsert;
export type ProjectPensRow = typeof projectPens.$inferSelect;

/** Full schema object for the Drizzle client. */
export const schema = {
  users,
  sessionsAuth,
  secrets,
  nodes,
  projects,
  agentSessions,
  agentCapabilities,
  events,
  pushSubscriptions,
  auditLog,
  projectPens,
};
