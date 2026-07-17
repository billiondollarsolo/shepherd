/**
 * Agent launch commands — the argv Shepherd runs as a session's PTY program to
 * actually start the coding agent (FR-S1).
 *
 * Each first-class agent ships a CLI on PATH. Plain shell access is represented
 * explicitly by `terminal`. The command is launched
 * by flock-agentd as the session's foreground process and its TUI streams over
 * the PTY⇄WS bridge.
 *
 * Keeping this in one place means adding/renaming an agent binary is a one-line
 * change, and both the local and SSH transports launch agents identically.
 */
import type { AgentType, SessionPermissionMode, SessionReasoningEffort, Status } from '@flock/shared';

/**
 * Map a Shepherd {@link SessionReasoningEffort} to Codex's config override flags.
 * Codex exposes reasoning effort as a config key (`model_reasoning_effort`), set
 * with `-c key=value`. `default` (or unset) leaves Codex's own default. Other
 * agents bake effort into the model choice and don't use this.
 */
function codexReasoningFlags(effort: SessionReasoningEffort): string[] {
  if (effort === 'default') return [];
  return ['-c', `model_reasoning_effort=${effort}`];
}

/**
 * Map a Shepherd {@link SessionPermissionMode} to Claude Code's CLI flags.
 *   default     → none (Claude's normal prompting)
 *   acceptEdits → --permission-mode acceptEdits (auto-accept edits, ask the rest)
 *   plan        → --permission-mode plan (read-only planning)
 *   autonomous  → --dangerously-skip-permissions (no prompts at all)
 */
function claudePermissionFlags(mode: SessionPermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':
      return ['--permission-mode', 'acceptEdits'];
    case 'plan':
      return ['--permission-mode', 'plan'];
    case 'autonomous':
      return ['--dangerously-skip-permissions'];
    case 'default':
    default:
      return [];
  }
}

/**
 * Map a Shepherd {@link SessionPermissionMode} to Codex's CLI flags. Codex has two
 * orthogonal axes (sandbox + approval); we pick coherent presets:
 *   default     → none (Codex's own default)
 *   acceptEdits → --sandbox workspace-write (write in workspace; `--full-auto` is
 *                 deprecated in current Codex, this is the documented replacement)
 *   plan        → --sandbox read-only --ask-for-approval never
 *   autonomous  → --dangerously-bypass-approvals-and-sandbox (no sandbox/approvals)
 */
function codexPermissionFlags(mode: SessionPermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':
      return ['--sandbox', 'workspace-write'];
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'autonomous':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'default':
    default:
      return [];
  }
}

/**
 * Map a Shepherd {@link SessionPermissionMode} to Gemini CLI's approval flags (T20):
 *   default      → none (interactive — Gemini asks)
 *   plan         → --approval-mode plan (read-only plan mode; current gemini CLI)
 *   acceptEdits  → --approval-mode auto_edit (auto-accept edits, ask for the rest)
 *   autonomous   → --yolo (auto-approve everything)
 */
function geminiPermissionFlags(mode: SessionPermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--approval-mode', 'plan'];
    case 'acceptEdits':
      return ['--approval-mode', 'auto_edit'];
    case 'autonomous':
      return ['--yolo'];
    case 'default':
    default:
      return [];
  }
}

// Antigravity CLI (`agy`) permission modes (from `agy --help`, v1.1.3):
//   plan        → --mode plan           (read-only plan mode)
//   acceptEdits → --mode accept-edits   (auto-accept edits, ask for the rest)
//   autonomous  → --dangerously-skip-permissions  (auto-approve everything)
function antigravityPermissionFlags(mode: SessionPermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'autonomous':
      return ['--dangerously-skip-permissions'];
    case 'default':
    default:
      return [];
  }
}

/** The daemon session kind: a real agent, a bare shell, or a supervised dev process. */
export type SessionKind = 'agent' | 'shell' | 'dev';

/**
 * Per-agent launch + status policy in ONE table — the single place to answer
 * "what binary, which flags, what daemon kind, what initial status, and how is
 * live status derived" for an agent type. Adding an agent is a one-row edit, and
 * the exhaustive `Record<AgentType, …>` makes a missing agent a compile error.
 */
interface AgentCaps {
  /** Base argv to launch; undefined = no fixed program (bare shell / dev's devCommand). */
  readonly command?: readonly string[];
  /** Permission-mode → extra CLI flags appended to `command`. */
  readonly permissionFlags?: (mode: SessionPermissionMode) => string[];
  /** CLI flag that injects a system prompt (e.g. claude `--append-system-prompt`),
   *  if the agent supports one. Followed by the prompt string as a separate argv. */
  readonly systemPromptFlag?: string;
  /** CLI flag that selects the model (e.g. `--model`), if the agent supports one.
   *  Followed by the model string as a separate argv (safe for values with spaces,
   *  e.g. Antigravity's `"Claude Opus 4.6 (Thinking)"`, since argv is exec'd as an
   *  array with no shell). */
  readonly modelFlag?: string;
  /** Reasoning-effort → extra CLI flags, for agents that expose effort independently
   *  of the model (Codex). Agents that bake effort into the model don't set this. */
  readonly reasoningEffortFlags?: (effort: SessionReasoningEffort) => string[];
  /** Argv appended to resume the most-recent conversation in the cwd, for agents
   *  whose CLI can pick it back up on relaunch (e.g. `--continue`). Set only for
   *  agents that support it; unset means a relaunch starts a fresh conversation. */
  readonly resumeArgs?: readonly string[];
  /** Daemon session kind. */
  readonly kind: SessionKind;
  /** Status before any source (hook/transcript/activity) reports. */
  readonly initialStatus: Status;
  /**
   * Derive live status from PTY OUTPUT ACTIVITY (the daemon's activity heuristic)
   * — true only for agents with no hook AND no transcript source;
   * claude/codex/opencode have better sources and must NOT use it (it would fight them).
   */
  readonly activityStatus: boolean;
  /**
   * Optional headless auth bootstrap. When BOTH are set, the launch is wrapped so
   * the node first checks if the agent is already authenticated (`authProbe`, a
   * shell test) and, only if not, runs a headless sign-in (`authBootstrap`) before
   * exec'ing the agent. Lets an unauthed session show a device-code flow in the
   * terminal, while an authed session goes straight in (no prompt). Shell snippets
   * run via `sh -c`, so they see the session's (augmented-PATH) environment.
   */
  readonly authProbe?: string;
  readonly authBootstrap?: string;
}

const AGENT_CAPS: Record<AgentType, AgentCaps> = {
  'claude-code': {
    command: ['claude'],
    permissionFlags: claudePermissionFlags,
    systemPromptFlag: '--append-system-prompt',
    modelFlag: '--model',
    // `claude --continue` resumes the most-recent conversation in the cwd, so a
    // model-switch relaunch keeps the transcript.
    resumeArgs: ['--continue'],
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
  },
  // Antigravity CLI (`agy`): native PTY/TUI (no ACP). Interactive terminal login
  // (browser / SSH auth URL) works on the PTY path like claude/codex. Status +
  // chat come from tailing agy's per-conversation transcript JSONL (agentd
  // status.watchAntigravity), so no PTY-activity fallback is needed.
  antigravity: {
    command: ['agy'],
    permissionFlags: antigravityPermissionFlags,
    // agy's model list (from `agy models`) bakes the speed/effort into the model
    // name, e.g. "Claude Opus 4.6 (Thinking)" / "Gemini 3.5 Flash (High)", so there
    // is no separate reasoning-effort flag.
    modelFlag: '--model',
    // `agy --continue` resumes the most-recent conversation in the cwd, so a
    // model-switch relaunch keeps the transcript.
    resumeArgs: ['--continue'],
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
  },
  codex: {
    command: ['codex'],
    permissionFlags: codexPermissionFlags,
    modelFlag: '--model',
    reasoningEffortFlags: codexReasoningFlags,
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
  },
  // OpenCode has its own in-app permission config, so it takes no launch flag.
  opencode: {
    command: ['opencode'],
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
  },
  // Gemini launches over ACP (`acpLaunchCommand`) for status + chat. activityStatus
  // is false so a PTY path wouldn't fight hooks; the live ACP path also sets
  // activityStatus:false at open. Permission flags apply to both PTY and ACP argv.
  gemini: {
    command: ['gemini'],
    permissionFlags: geminiPermissionFlags,
    modelFlag: '--model',
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
  },
  // xAI Grok Build CLI (binary `grok`). No documented autonomy flags (Plan Mode is
  // its built-in safety gate). Grok fires Claude-Code-compatible lifecycle hooks
  // (session_start/pre_tool_use/post_tool_use/stop) that reach Shepherd's hook
  // endpoint, so status is HOOK-driven (the Grok translator) — NOT the PTY activity
  // heuristic, which would fight it (`activityStatus: false`). Headless-friendly
  // auth: if not already signed in (no ~/.grok/auth.json and no XAI_API_KEY), run
  // the DEVICE-CODE flow in-terminal before starting (the browser flow's localhost
  // callback can't work on a remote node); an already-authed session skips straight in.
  grok: {
    command: ['grok'],
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: false,
    authProbe: '[ -f "$HOME/.grok/auth.json" ] || [ -n "$XAI_API_KEY" ]',
    authBootstrap: 'grok login --device-auth',
  },
  // Additional CLI agents — launchable if installed on the node; status via PTY
  // activity (no transcript/hook integration yet, like gemini/grok historically).
  aider: { command: ['aider'], kind: 'agent', initialStatus: 'starting', activityStatus: true },
  'cursor-agent': {
    command: ['cursor-agent'],
    kind: 'agent',
    initialStatus: 'starting',
    activityStatus: true,
  },
  amp: { command: ['amp'], kind: 'agent', initialStatus: 'starting', activityStatus: true },
  // terminal: a plain shell; dev: devCommand (sh -lc) assembled by the session service.
  terminal: { kind: 'shell', initialStatus: 'running', activityStatus: false },
  dev: { kind: 'dev', initialStatus: 'running', activityStatus: false },
};

/**
 * The argv that starts an agent, or undefined for a bare shell / dev (whose
 * command rides CreateSessionRequest.devCommand). `permissionMode` appends the
 * agent's autonomy flags (default → none).
 *
 * When the agent declares an auth bootstrap (`authProbe`/`authBootstrap`), the
 * argv is wrapped as `sh -c '<probe> || <bootstrap>; exec <agent…>'` so the node
 * signs in (headless device-code flow) ONLY when not already authenticated, then
 * `exec`s the agent in the same session — an authed session skips straight in.
 */
export function agentLaunchCommand(
  agentType: AgentType,
  permissionMode: SessionPermissionMode = 'default',
  systemPrompt?: string,
  model?: string,
  reasoningEffort?: SessionReasoningEffort,
  /** Extra argv appended verbatim (e.g. a resume flag like agy `--continue` when
   *  relaunching to change the model mid-conversation). */
  extraArgs?: readonly string[],
): string[] | undefined {
  const caps = AGENT_CAPS[agentType];
  if (!caps.command) return undefined;
  const argv = [...caps.command, ...(caps.permissionFlags?.(permissionMode) ?? [])];
  // Select the model for agents with a flag for it (claude/codex/gemini/agy). argv
  // is exec'd as an ARRAY (no shell), so a value with spaces/parens needs no quoting.
  if (model && caps.modelFlag && !(caps.authProbe && caps.authBootstrap)) {
    argv.push(caps.modelFlag, model);
  }
  // Reasoning effort for agents that expose it independently of the model (codex).
  if (reasoningEffort && caps.reasoningEffortFlags && !(caps.authProbe && caps.authBootstrap)) {
    argv.push(...caps.reasoningEffortFlags(reasoningEffort));
  }
  // Inject a system prompt for agents that support a flag for it (claude). The argv
  // is exec'd as an ARRAY (no shell), so a multi-word prompt needs no quoting. We
  // skip it on the auth-wrapper path below (join-into-exec can't carry spaces, and
  // no wrapper-using agent has a systemPromptFlag).
  if (systemPrompt && caps.systemPromptFlag && !(caps.authProbe && caps.authBootstrap)) {
    argv.push(caps.systemPromptFlag, systemPrompt);
  }
  if (extraArgs && extraArgs.length > 0 && !(caps.authProbe && caps.authBootstrap)) {
    argv.push(...extraArgs);
  }
  if (caps.authProbe && caps.authBootstrap) {
    // argv tokens here are simple (no spaces/quoting needed) for the agents that
    // use this; join into the `exec` target of the auth-then-run wrapper.
    return ['sh', '-c', `${caps.authProbe} || ${caps.authBootstrap}; exec ${argv.join(' ')}`];
  }
  return argv;
}

/**
 * The status a freshly-created session starts in. Agent sessions with a hook
 * stream begin `starting` (hooks move them to running/awaiting_input); sessions
 * with no status source (terminal/dev/gemini) start `running` so they don't sit
 * at `starting` forever.
 */
export function initialSessionStatus(agentType: AgentType): Status {
  return AGENT_CAPS[agentType].initialStatus;
}

/** The daemon session kind for an agent type (agent | shell | dev). */
export function agentSessionKind(agentType: AgentType): SessionKind {
  return AGENT_CAPS[agentType].kind;
}

/**
 * The argv that resumes the most-recent conversation in the cwd for this agent,
 * or `[]` when the agent's CLI can't resume (→ a relaunch starts fresh). Passed as
 * `extraArgs` to {@link agentLaunchCommand} on a model-switch relaunch so the
 * conversation continues where the CLI can pick it back up.
 */
export function agentResumeArgs(agentType: AgentType): string[] {
  return [...(AGENT_CAPS[agentType].resumeArgs ?? [])];
}

/**
 * The ACP (structured transport, F6) launch argv for agents that speak the Agent
 * Client Protocol, or null when the agent has no ACP entrypoint (→ use the PTY
 * path).
 *
 * VERIFIED LIVE (2026-06-08): only **gemini** (`--experimental-acp`) answers the
 * ACP `initialize` handshake. **grok** does NOT — `grok agent stdio` is a JSON
 * line protocol but ignores ACP's `initialize` (no response), so it must run as a
 * native PTY (status via its Claude-compatible hooks), not ACP. Re-add an agent
 * here only after confirming it responds to `initialize` over stdio.
 */
export function acpLaunchCommand(
  agentType: AgentType,
  // Reserved for when ACP is re-enabled with an auth handshake (Gemini's autonomy
  // flags carry into the ACP argv); unused while every agent takes the PTY path.
  _permissionMode: SessionPermissionMode = 'default',
): string[] | null {
  switch (agentType) {
    // Gemini CAN speak ACP (`--experimental-acp`), and agentd still supports it,
    // but ACP is headless (no PTY) — which means the interactive Google sign-in
    // has nowhere to appear, so an unauthenticated node dead-ends at
    // "API key is missing". Until Shepherd drives the ACP auth handshake, launch
    // Gemini on the PTY path instead: the terminal shows the real Gemini TUI, the
    // sign-in prompt works exactly like before, and the Chat view still renders
    // its transcript. Re-enable ACP here once the auth flow is wired (structured
    // chat plan §Phase 1). Permission flags still apply on the PTY argv below.
    default:
      return null;
  }
}

/** Whether an agent type can run over the structured ACP transport. */
export function agentSupportsAcp(agentType: AgentType): boolean {
  return acpLaunchCommand(agentType) !== null;
}

/**
 * The Claude STREAM-JSON transport launch argv, or null for any non-claude agent.
 *
 * Claude Code runs structured (and PERSISTENT — stdin stays open for multi-turn) via
 * `claude --print --input-format stream-json --output-format stream-json --verbose`,
 * plus the usual permission/model flags. agentd's `claude-stream` transport
 * (claudestream_session.go) parses its ndjson output into the same canonical events
 * the ACP bridge consumes, so chat + status flow through the identical pipeline.
 *
 * REAL AUDITED APPROVALS: `--permission-prompt-tool stdio` routes every permission-
 * gated tool to the stream-json CONTROL protocol (can_use_tool → control_response over
 * stdin/stdout) instead of auto-running. agentd's claude-stream driver
 * (claudestream_session.go) surfaces each request as an approval card and writes the
 * operator's y/n back as a control_response — so `default` now gates properly and is
 * passed through UNCHANGED (no more default→acceptEdits auto-run). `plan`/`acceptEdits`
 * narrow what still gets asked; `autonomous` (--dangerously-skip-permissions) skips
 * approval entirely and MUST NOT be combined with the prompt-tool flag, so it's omitted
 * in that mode. VERIFIED LIVE (claude 2.1.212): the flag alone triggers can_use_tool;
 * no client `initialize` handshake is required.
 */
export function claudeStreamLaunchCommand(
  agentType: AgentType,
  permissionMode: SessionPermissionMode = 'default',
  model?: string,
): string[] | null {
  if (agentType !== 'claude-code') return null;
  // `--permission-prompt-tool stdio` and `--dangerously-skip-permissions` are mutually
  // exclusive: autonomous skips approval, so it takes no prompt-tool flag.
  const promptToolFlags =
    permissionMode === 'autonomous' ? [] : ['--permission-prompt-tool', 'stdio'];
  return [
    'claude',
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    ...promptToolFlags,
    ...claudePermissionFlags(permissionMode),
    ...(model ? ['--model', model] : []),
  ];
}

/**
 * The Codex APP-SERVER (structured JSON-RPC) transport launch argv, or null for any
 * non-codex agent.
 *
 * `codex app-server` is a long-running newline-delimited JSON-RPC server on stdio.
 * agentd's `codex-app-server` transport (codexappserver_session.go) drives its
 * lifecycle (initialize → thread/start → turn/start) and maps the streamed item/*
 * notifications onto the SAME canonical events the ACP/claude-stream bridges emit —
 * so tool cards + chat + status flow through the identical pipeline.
 *
 * Permission handling is NOT a launch flag here: the app-server surfaces every
 * permission-gated action as an approval SERVER-REQUEST (the item requestApproval
 * methods), which the driver renders as an approval card and answers with the
 * operator's y/n. So no sandbox/ask-for-approval flags are appended (unlike PTY).
 */
export function codexAppServerLaunchCommand(agentType: AgentType): string[] | null {
  if (agentType !== 'codex') return null;
  return ['codex', 'app-server'];
}

/** Whether the daemon should derive this agent's status from PTY activity (T61). */
export function agentUsesActivityStatus(agentType: AgentType): boolean {
  return AGENT_CAPS[agentType].activityStatus;
}

/**
 * Foreground process names that are the agent TUI itself (not a sub-tool).
 * watchForeground reports these as tool + running whenever the CLI owns the PTY
 * — including while idle at the prompt. Real tool use uses names like Bash/Edit.
 */
const BARE_AGENT_PROCESS_NAMES = new Set([
  'grok',
  'opencode',
  'gemini',
  'claude',
  'codex',
  'aider',
  'cursor-agent',
  'amp',
]);

/** True when `tool` is just the agent binary sitting on the PTY (not real work). */
export function isBareAgentProcessName(tool: string | null | undefined): boolean {
  if (!tool) return false;
  const base = tool.trim().split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return BARE_AGENT_PROCESS_NAMES.has(base);
}
