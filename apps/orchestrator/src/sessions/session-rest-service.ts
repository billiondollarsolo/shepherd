/**
 * SessionRestService — REST list/create over the agent_sessions registry,
 * preserving the single authoritative record invariant (spec §4.2).
 *
 *   GET  /api/sessions[?projectId=...]   list sessions (mapped, no plaintext)
 *   POST /api/sessions                   create a session (one id threads the
 *                                        record name + hook token + browser endpoint)
 *
 * Create resolves the project → its node + working_dir, mints a per-session hook
 * token (returned ONCE; only its hash is stored, NFR-SEC3), and inserts the ONE
 * authoritative record via the shared session mappers. It then launches the agent
 * on the node's flock-agentd daemon best-effort: a launch failure marks the
 * session 'error' (the connection dot shows disconnected) but the record is still
 * persisted (the paddock must always see the session) — never a silent shell.
 *
 * Postgres here is the registry/identity write path, NOT the live status path
 * (spec §6.6). The hook token hash is produced by the injected hasher so this
 * service has no crypto of its own and stays unit-testable.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  agentAuthorityScopes,
  authorityAllows,
  ProjectAgentPolicySchema,
  type AgentCapabilityScope,
  type CreateSessionRequest,
  type SessionRecord,
} from '@flock/shared';

import type { AuditLogger } from '../audit/audit.js';
import type { Database } from '../db/client.js';
import { rowToSession, sessionToRow } from '../db/mappers.js';
import { agentSessions, nodes, projects } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  acpLaunchCommand,
  agentSupportsAcp,
  agentLaunchCommand,
  initialSessionStatus,
} from './agent-launch.js';

/** Raised when the target project id does not resolve (→ 404, spec §10). */
export class SessionProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project "${projectId}" was not found.`);
    this.name = 'SessionProjectNotFoundError';
  }
}

export class SessionPolicyViolationError extends Error {
  constructor() {
    super('Requested orchestration authority exceeds the project policy.');
    this.name = 'SessionPolicyViolationError';
  }
}

/** Hashes a plaintext hook token; only the hash is persisted (NFR-SEC3). */
export type HookTokenHasher = (plaintext: string) => Promise<string>;

/** Outcome of an {@link SessionRestServiceDeps.agentdLaunch} attempt. */
export type AgentdLaunchOutcome = 'launched' | 'failed';

export interface SessionRestServiceDeps {
  db: Database;
  /** Hashes the minted hook token (e.g. argon2id). */
  hashToken: HookTokenHasher;
  audit: AuditLogger;
  /**
   * Per-session env injected into the launched agent (hook URL/token/config dir,
   * US-19). Resolver so the caller can mint session-scoped values. Optional.
   */
  sessionEnv?: (
    session: SessionRecord,
    hookToken: string,
    orchestrationToken?: string,
  ) => Promise<Record<string, string>>;
  /** Issues a separate optional orchestration credential. Empty scopes issue none. */
  issueOrchestrationCapability?: (
    session: SessionRecord,
    scopes: readonly AgentCapabilityScope[],
  ) => Promise<string | undefined>;
  /**
   * Called synchronously after the authoritative record is persisted, BEFORE the
   * tmux launch, so live channels (status map + hook binding + PTY) can track the
   * session immediately (the sidebar shows "starting" and the terminal can
   * attach). Receives the persisted session + its plaintext hook token (the token
   * is needed nowhere else; only its hash is stored).
   */
  onSessionCreated?: (session: SessionRecord, hookToken: string) => void;
  /**
   * Launch the agent on the node's flock-agentd daemon (the only transport).
   * Returns 'launched' on success or 'failed' on a hard failure — in which case
   * it has already marked the session 'error' (the connection dot shows
   * disconnected), so the failure is visible, never a silent shell.
   */
  agentdLaunch?: (args: {
    session: SessionRecord;
    nodeKind: string;
    command?: string[];
    env?: Record<string, string>;
    /** Session transport: "acp" for the structured path; undefined = PTY. */
    mode?: string;
  }) => Promise<AgentdLaunchOutcome>;
  /** Optional sink for best-effort tmux failures; defaults to console.warn. */
  logger?: { warn(msg: string, err: unknown): void };
}

export interface SessionActionContext {
  userId: string;
  ip?: string | null;
}

export class SessionRestService {
  private readonly db: Database;
  private readonly hashToken: HookTokenHasher;
  private readonly audit: AuditLogger;
  private readonly sessionEnv?: (
    session: SessionRecord,
    hookToken: string,
    orchestrationToken?: string,
  ) => Promise<Record<string, string>>;
  private readonly issueOrchestrationCapability?: SessionRestServiceDeps['issueOrchestrationCapability'];
  private readonly onSessionCreated?: (session: SessionRecord, hookToken: string) => void;
  private readonly agentdLaunch?: (args: {
    session: SessionRecord;
    nodeKind: string;
    command?: string[];
    env?: Record<string, string>;
    /** Session transport: "acp" for the structured path; undefined = PTY. */
    mode?: string;
  }) => Promise<AgentdLaunchOutcome>;
  private readonly logger: { warn(msg: string, err: unknown): void };

  constructor(deps: SessionRestServiceDeps) {
    this.db = deps.db;
    this.hashToken = deps.hashToken;
    this.audit = deps.audit;
    this.sessionEnv = deps.sessionEnv;
    this.issueOrchestrationCapability = deps.issueOrchestrationCapability;
    this.onSessionCreated = deps.onSessionCreated;
    this.agentdLaunch = deps.agentdLaunch;
    this.logger = deps.logger ?? {
      warn(msg, err) {
        // eslint-disable-next-line no-console
        console.warn(`[flock-orchestrator] ${msg}`, err);
      },
    };
  }

  /**
   * List OPEN sessions (closed_at IS NULL), optionally narrowed to a project.
   * Terminated sessions are excluded so they leave the paddock tree immediately;
   * their history lives in the registry/audit log, not the live session list.
   */
  async listSessions(projectId?: string): Promise<SessionRecord[]> {
    const openOnly = isNull(agentSessions.closedAt);
    const where = projectId ? and(eq(agentSessions.projectId, projectId), openOnly) : openOnly;
    const rows = await this.db.select().from(agentSessions).where(where);
    return rows.map(rowToSession);
  }

  /**
   * Create a session for a project. Resolves project → node + working_dir, mints
   * the per-session hook token (returned once), inserts the ONE authoritative
   * record, and launches the agent on the node's flock-agentd daemon best-effort.
   * Throws {@link SessionProjectNotFoundError} (→ 404) for an unknown project.
   */
  async createSession(
    input: CreateSessionRequest,
    ctx: SessionActionContext,
  ): Promise<{ session: SessionRecord; hookToken: string }> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) {
      throw new SessionProjectNotFoundError(input.projectId);
    }

    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, project.nodeId)).limit(1);
    if (!node) {
      // A project always references a node (FK), but guard defensively.
      throw new SessionProjectNotFoundError(input.projectId);
    }

    const id = randomUUID();
    // Stable per-session name (the daemon keys by session id; this is a legacy
    // label still stored on the record + used as the terminate lookup key).
    const tmuxSessionName = `flock-${id.replace(/[.:]/g, '-')}`;
    const workingDir = input.workingDir ?? project.workingDir;
    const policy = ProjectAgentPolicySchema.parse(project.agentPolicy);
    const orchestrationAuthority = input.orchestrationAuthority ?? policy.defaultAuthority;
    if (!authorityAllows(policy.maxAuthority, orchestrationAuthority)) {
      throw new SessionPolicyViolationError();
    }

    // Mint the per-session hook token: returned ONCE, only its hash is stored.
    const hookToken = randomBytes(32).toString('base64url');
    const hookTokenHash = await this.hashToken(hookToken);

    const now = new Date().toISOString();
    // ONE id threads the session name + hook token hash + (null) browser endpoint (§4.2).
    const record: SessionRecord = {
      id,
      nodeId: node.id,
      projectId: project.id,
      agentType: input.agentType,
      tmuxSessionName,
      workingDir,
      browserCdpEndpoint: null,
      hookTokenHash,
      // Agents wait for their hook stream (`starting`); a hook-less terminal is
      // `running` the moment its shell spawns (see initialSessionStatus).
      status: initialSessionStatus(input.agentType),
      statusDetail: null,
      pinned: false,
      note: null,
      reviewedAt: null,
      // T18: persist the autonomy level so it survives restart + shows in the UI.
      permissionMode: input.permissionMode ?? 'default',
      orchestrationAuthority,
      createdAt: now,
      lastStatusAt: now,
      createdBy: ctx.userId,
      closedAt: null,
    };

    const [row] = await this.db.insert(agentSessions).values(sessionToRow(record)).returning();
    if (!row) {
      throw new Error('Failed to persist agent_session record.');
    }
    const persisted = rowToSession(row);

    let orchestrationToken: string | undefined;
    if (this.issueOrchestrationCapability) {
      try {
        orchestrationToken = await this.issueOrchestrationCapability(
          persisted,
          agentAuthorityScopes(orchestrationAuthority),
        );
      } catch (err) {
        // The session is not live or visible yet. Roll back the registry row so
        // an explicitly requested capability never degrades into ambiguous state.
        await this.db.delete(agentSessions).where(eq(agentSessions.id, persisted.id));
        throw err;
      }
    }

    // Track the session in the live channels (status map + hook binding + PTY)
    // BEFORE the agent launch, so the sidebar shows "starting" and the terminal
    // can attach the moment the daemon session exists.
    if (this.onSessionCreated) {
      try {
        this.onSessionCreated(persisted, hookToken);
      } catch {
        /* tracking is best-effort; create succeeds regardless. */
      }
    }

    // Launch the agent on the node's flock-agentd daemon (best-effort): a failure
    // must NOT 500 — the record is already persisted and listable. permissionMode
    // is persisted on the record (T18) AND drives the launch flags here.
    // Defaults to interactive when omitted. A `dev` session runs its configured
    // command through the node shell so the daemon can supervise + auto-restart it.
    // Transport is AUTO-SELECTED per agent so the user never chooses (and always
    // gets a structured Chat log): native PTY for agents Flock can tail a live
    // transcript from — claude/codex (+ opencode via hooks) — preserving their
    // native TUI; ACP for agents with NO live transcript (gemini/grok) so their
    // conversation is still captured as structured messages. `dev` is always a
    // supervised shell command.
    const acpArgv =
      persisted.agentType === 'dev'
        ? null
        : agentSupportsAcp(persisted.agentType)
          ? acpLaunchCommand(persisted.agentType, input.permissionMode)
          : null;
    const mode = acpArgv ? 'acp' : undefined;
    const command =
      acpArgv ??
      (persisted.agentType === 'dev' && input.devCommand
        ? ['sh', '-lc', input.devCommand]
        : agentLaunchCommand(persisted.agentType, input.permissionMode, input.systemPrompt));
    const env = this.sessionEnv
      ? await this.sessionEnv(persisted, hookToken, orchestrationToken).catch(() => undefined)
      : undefined;
    // Launch path: flock-agentd owns the agent/terminal process. On a hard failure
    // it marks the session 'error' (the connection dot shows disconnected) — the
    // record persists with no live process; there is no tmux fallback.
    if (this.agentdLaunch) {
      try {
        await this.agentdLaunch({ session: persisted, nodeKind: node.kind, command, env, mode });
      } catch (err) {
        this.logger.warn(`agentd launch failed for session ${persisted.id}`, err);
      }
    }

    // Append the security-relevant audit row (FR-A3). Best-effort, off the live path.
    try {
      await this.audit.recordSessionCreate({
        sessionId: persisted.id,
        userId: ctx.userId,
        ip: ctx.ip ?? null,
        detail: {
          agentType: persisted.agentType,
          nodeId: persisted.nodeId,
          orchestrationAuthority: persisted.orchestrationAuthority,
        },
      });
    } catch {
      /* swallow — create succeeds regardless (FR-A3 best-effort here). */
    }

    return { session: persisted, hookToken };
  }

  /**
   * Update supervisor-facing metadata (pin / note) on a session. Cosmetic
   * registry fields only — never touches the live status or process. Returns the
   * updated session, or null when the id is unknown (→ 404). Omitted fields are
   * left unchanged; `note: null` clears the note.
   */
  async updateSession(
    id: string,
    patch: { pinned?: boolean; note?: string | null; reviewed?: boolean },
    ctx?: { userId?: string | null },
  ): Promise<SessionRecord | null> {
    const set: {
      pinned?: boolean;
      note?: string | null;
      reviewedAt?: Date | null;
      reviewedBy?: string | null;
    } = {};
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.reviewed !== undefined) {
      // Stamp who/when on review; clearing review wipes both.
      set.reviewedAt = patch.reviewed ? new Date() : null;
      set.reviewedBy = patch.reviewed ? (ctx?.userId ?? null) : null;
    }
    if (Object.keys(set).length === 0) {
      const [row] = await this.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .limit(1);
      return row ? rowToSession(row) : null;
    }
    const [row] = await this.db
      .update(agentSessions)
      .set(set)
      .where(eq(agentSessions.id, id))
      .returning();
    return row ? rowToSession(row) : null;
  }
}
