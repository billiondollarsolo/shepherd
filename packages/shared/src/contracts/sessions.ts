import { z } from 'zod';
import {
  AgentAuthorityEnum,
  AgentTypeEnum,
  IsoTimestamp,
  SessionPermissionModeEnum,
  SessionReasoningEffortEnum,
  SessionSchema,
  Uuid,
} from '../domain.js';

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
export const CreateSessionRequest = z
  .object({
    projectId: Uuid,
    agentType: AgentTypeEnum,
    /** Optional override; defaults to the project's working_dir. */
    workingDir: z.string().min(1).optional(),
    /**
     * Autonomy level to launch the agent with (maps to per-agent CLI flags).
     * Defaults to `default` (interactive prompting) when omitted.
     */
    permissionMode: SessionPermissionModeEnum.optional(),
    /** Optional system prompt injected at launch (agents with a flag, e.g. claude
     *  `--append-system-prompt`); ignored by agents without one. */
    systemPrompt: z.string().min(1).max(8000).optional(),
    /**
     * Model to launch the agent with (maps to the CLI's `--model` flag). The value
     * is whatever that CLI accepts — e.g. Antigravity's display name
     * `"Claude Opus 4.6 (Thinking)"` from `agy models`, or claude/codex's model id.
     * Omitted → the CLI's own default model.
     */
    model: z.string().min(1).max(200).optional(),
    /**
     * Reasoning-effort / speed for agents that expose it independently of the model
     * (Codex). Omitted / `default` → the CLI default. Ignored by agents that bake
     * effort into the model choice (Antigravity).
     */
    reasoningEffort: SessionReasoningEffortEnum.optional(),
    /**
     * Opt into the STRUCTURED chat transport (rich tool cards, approvals, dynamic
     * slash) instead of the PTY + real TUI. Default false (terminal-first). Only
     * honored for agents that have a structured transport (currently claude-code).
     */
    structuredChat: z.boolean().optional(),
    /**
     * For an agentType of `dev` ONLY: the shell command to run as a supervised,
     * auto-restarting dev process (e.g. `npm run dev`). Required when agentType is
     * `dev`, ignored otherwise. Run via the node's shell (`sh -lc`).
     */
    devCommand: z.string().min(1).max(2000).optional(),
    /**
     * Session transport (F6). `acp` runs an ACP-capable agent (gemini/grok) over the
     * structured Agent Client Protocol instead of a raw PTY — enabling structured
     * status, telemetry, and approve/deny. Ignored (falls back to PTY) for agents
     * with no ACP entrypoint. Default: PTY.
     */
    transport: z.enum(['pty', 'acp']).optional(),
    /** Optional, explicit Shepherd orchestration authority. Omitted means the agent
     * receives callback-only credentials and cannot inspect/control siblings. */
    orchestrationAuthority: AgentAuthorityEnum.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.agentType === 'dev' && !val.devCommand?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['devCommand'],
        message: 'devCommand is required for a dev session.',
      });
    }
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** Session-create response. Agent-only capability material never reaches the web. */
export const CreateSessionResponse = z.object({
  session: SessionSchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

/** GET /api/sessions/:id */
export const SessionResponse = z.object({ session: SessionSchema });
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Path param for the session-scoped routes (`/api/sessions/:id`). */
export const SessionIdParams = z.object({ id: Uuid });
export type SessionIdParams = z.infer<typeof SessionIdParams>;

/**
 * PATCH /api/sessions/:id — update the supervisor-facing free-text note.
 * `note: null` clears the note. Does NOT touch the
 * live status / process — purely cosmetic registry fields. Returns the session.
 */
export const UpdateSessionRequest = z
  .object({
    /** Markdown-capable supervisor note (raised for herdr-aligned notes). */
    note: z.string().max(32000).nullable().optional(),
  })
  .refine((value) => value.note !== undefined, {
    message: 'provide note to update.',
  });
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/**
 * POST /api/sessions/:id/relaunch — swap the running agent's model / reasoning
 * effort mid-session WITHOUT allocating a new session id. The orchestrator closes
 * the agentd PTY for the id and re-opens a fresh PTY with the SAME id and a new
 * launch command, preserving the conversation via the CLI's own resume flag. The
 * authoritative DB record (same id, working dir, project) stays OPEN — only the OS
 * process/PTY is replaced. Response reuses `SessionResponse` ({ session }).
 *
 *   model:  a string sets the CLI `--model`; `null` clears it to the CLI default;
 *           `undefined` (omitted) leaves the persisted model unchanged.
 *   reasoningEffort: omitted leaves the persisted effort unchanged.
 */
export const RelaunchSessionRequest = z.object({
  model: z.string().min(1).max(200).nullable().optional(),
  reasoningEffort: SessionReasoningEffortEnum.optional(),
});
export type RelaunchSessionRequest = z.infer<typeof RelaunchSessionRequest>;

/**
 * DELETE /api/sessions/:id — terminate (US-13, FR-S5). The orchestrator kills
 * the daemon session, revokes its capabilities, marks the authoritative
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
