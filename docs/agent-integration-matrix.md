# Agent integration matrix

How Flock derives live supervision signals for each supported coding-agent CLI —
what we capture, the mechanism, and the known gaps. This is the authoritative
reference for "how well do we work with agent X." Verified against real on-disk
transcripts/hooks (last reviewed 2026-06-05).

Flock's model: **leverage what the agent already produces on the node** — its
transcript files (tailed by `flock-agentd`) and/or its lifecycle hooks (forwarded
to `POST /api/hooks/:id`). The orchestrator normalizes everything into the shared
`Status` enum + telemetry (rides the status WS → bottom bar + grid + sidebar) +
the `plan` event artifact (`/plan`).

## Capability matrix

✅ captured · ⚠️ partial / wired-but-not-flowing · ❌ missing

| Signal | Claude Code | Codex | Gemini | OpenCode | Grok |
|---|---|---|---|---|---|
| **Detection** (node-info) | ✅ PATH + npm/nvm scan | ✅ | ✅ | ✅ | ✅ |
| **Launch** + permission modes | ✅ `--permission-mode` / skip | ✅ `--sandbox workspace-write`/`read-only`/bypass | ✅ `--approval-mode plan`/`auto_edit` / `--yolo` | ✅ (in-app perms) | ✅ (Plan Mode is built-in; no mode picker) |
| running / idle | ✅ transcript + hooks | ✅ transcript | ✅ hooks (v0.26+)⁵ | ✅ hooks | ✅ hooks |
| **awaiting_input** | ✅ hook `Notification`⁶ | ⚠️ hook `PermissionRequest` (schema+translator ready; seeding deferred)¹ | ✅ hook `Notification`⁵ | ✅ hook `permission.updated` | ❌ no approval event² |
| error | ✅ | ✅ transcript | ✅ hooks⁵ | ✅ | ✅ hook `PostToolUseFailure` |
| turn complete | ✅ `idle` (Stop)³ | ✅ `idle` | ✅ `idle` (AfterAgent) | ✅ `idle` (session.idle) | ✅ `idle` (stop) |
| done / session-end | ✅ `SessionEnd` + PTY exit³ | ✅ PTY exit (`SessionEnd` ready) | ✅ `SessionEnd` + PTY exit | ✅ PTY exit | ✅ `SessionEnd` + PTY exit |
| **tokens** (cumulative) | ✅ transcript usage | ✅ `total_token_usage` | ❌ (hooks=status; needs transcript tailer)⁵ | ✅ `message.updated`⁴ | ❌ |
| **model** name | ✅ `message.model` | ✅ `turn_context.model` | ❌⁵ | ✅⁴ | ❌ |
| **context %** | ✅ tokens ÷ model-info table | ✅ EXACT (`model_context_window`) | ❌⁵ | ✅⁴ | ❌ |
| **tasks / plan** | ✅ `TodoWrite` hook → plan | ✅ `update_plan` → plan | ❌ (no plan tool) | ✅ `todo.updated` → plan | ❌ |
| current tool | ✅ | ✅ (`exec`/`patch_apply`/…) | ✅ hook `BeforeTool`⁵ | ✅ (`tool` prop) | ✅ (`pre_tool_use` toolName) |

¹ Codex now ships Claude-style hooks incl. a `PermissionRequest` event (→
awaiting_input). Flock's shared schema + `codex.ts` translator are READY (tolerant
of both `hook_event_name`/`event` shapes), but Flock does not yet SEED codex hooks
— that means merging a `[hooks]` block into the user's real `~/.codex/config.toml`,
deferred until the exact on-disk format is validated on a live authed codex. The
transcript path already gives status/tokens/model/plan.
² Grok's hooks give tool start/stop/failure but no approval-prompt event.
³ UNIFIED "calm" model (2026-06-05): **turn-complete → `idle` for ALL agents**
(claude `Stop`, grok `stop`, codex `task_complete`/hook `Stop`, opencode
`session.idle`, gemini `AfterAgent`). `done` is reserved for an actual **session
end** (`SessionEnd` where the CLI has it + the PTY-exit path). Since Web Push fires
on `awaiting_input` / `error` / `done`, this means a push when an agent NEEDS you,
ERRORS, or ENDS — never on every turn.
⁴ OpenCode telemetry rides `message.updated`/`session.updated` → `openCodeTelemetry`
parses model/tokens/cost (exact USD) from `properties.info`. **Event names corrected
2026-06-05** against the SDK `Event` union: the live names are `session.created`,
`permission.updated`, `session.idle`, `todo.updated` (the previous guessed
`session.start`/`permission.request`/`question.ask`/`session.complete` were dead
subscriptions — now tolerated as legacy aliases). Validate against a live OpenCode.
⁵ **Gemini CLI v0.26.0+ hooks (NEW 2026-06-05).** Flock now seeds `~/.gemini/
settings.json` hooks (native deep-merge) → status from `SessionStart`/`BeforeAgent`/
`BeforeTool`/`AfterTool` (running + tool), `Notification` (awaiting_input),
`AfterAgent` (idle), `SessionEnd` (done) — replacing the old PTY-activity heuristic.
Doc-based; **validate the hook field casing on a live authed gemini** (a pre-0.26
build / wrong format would stall status at `starting`). tokens/model/context% would
need a `~/.gemini/tmp/.../chats/*.jsonl` transcript tailer — not yet built.
⁶ Claude `awaiting_input` is now robust: the translator derives the prompt kind
from `notification_type` if present, ELSE from the `message` text (current Claude
delivers the subtype as the hook matcher, not always a body field).

## Mechanism per agent

### Claude Code — most complete (hooks + transcript)
- **Hooks** (`$CLAUDE_CONFIG_DIR/settings.json`, Flock-seeded): `SessionStart`,
  `Pre/PostToolUse`, `Notification`, `Stop` → `status/translators/claude.ts`.
  `Notification:permission_prompt` → **awaiting_input** (the money state).
- **Transcript** (`~/.claude/projects/<slug>/<uuid>.jsonl`, `status/claude.go`):
  per-assistant-message `model`, `usage` (input + cache_read + cache_creation +
  output, summed for context occupancy). No context limit in the transcript →
  model-info table. mtime pre-filter avoids re-parsing stale transcripts.
- **Tasks**: `TodoWrite` `PostToolUse` → `hooks/plan.ts` → `plan` event.

### Codex — transcript-authoritative (hooks inert)
- **Transcript** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `status/codex.go`):
  state from `event_msg` lifecycle; `model` from `turn_context.model`; tokens from
  `token_count`→`info.total_token_usage`; **exact context limit** from
  `info.model_context_window`; **tasks** from `update_plan` → same `plan` artifact.
- **Hooks**: the seeded `hooks.toml` is best-effort/unverified (current Codex has
  `notify`, not per-tool hooks) — NOT a working awaiting_input source.

### Gemini — launch + activity heuristic (shallowest)
- No Flock-style hooks and no Flock-verified transcript format → **PTY-activity
  heuristic** (`Spec.ActivityStatus`, `manager_status.go watchActivity`): recent
  PTY output → running, a quiet gap → idle. A live dot only; no awaiting_input,
  tokens, model, or plan.

### OpenCode — hooks (per-session)
- **Plugin** (`$XDG_CONFIG_HOME/opencode/plugin/flock.js`, Flock-seeded): forwards
  `session.start`, `tool.execute.before/after`, `permission.request`,
  `question.ask`, `session.idle/error/complete` → `status/translators/opencode.ts`.
  Full per-session status incl. **awaiting_input**.
- **Telemetry**: fully wired — the plugin forwards `message.updated`/
  `session.updated`, the server extracts model/tokens/cost (see ⁴).

### Grok (xAI Grok Build CLI) — hook-driven (NOT activity)
- **Native hooks** (`~/.grok/hooks/flock.json`, Flock-seeded — global + always
  trusted, no `/hooks-trust` prompt): `session_start`/`pre_tool_use`/
  `post_tool_use`/`post_tool_use_failure`/`stop` → `status/translators/grok.ts`.
  camelCase fields, snake_case event values. `Notification` is intentionally NOT
  registered (grok fires ~30/turn of `xai_session` meta noise).
- Grok is Claude-Code-hook-compatible, so it gets REAL per-turn status (start /
  running(tool) / error / done) — `activityStatus:false`. No token/model/plan
  events, so no telemetry. Auth: `grok login --device-auth` wrapper on first run.

## Known gaps / follow-ups (prioritized)

1. **OpenCode telemetry — DONE (wired); validate against a live OpenCode** (⁴).
2. **Codex `done` + accurate cost** — decide whether transcript agents should emit
   a terminal `done` (affects Web Push); use Codex's real input/output token split
   (parsed but currently discarded) instead of the blended estimate.
3. **Gemini / Grok telemetry** — Gemini needs a verified `~/.gemini` log or its
   OTel export; Grok needs token/model hook events (none today).
4. **awaiting_input for Codex / Gemini / Grok** — no current signal; would need a
   mid-session prompt detector (OSC / pattern) or an agent-side notify shim.
5. **Per-process resource attribution** — node metrics are host-aggregate; a
   supervisor can't see which session burns CPU/RAM.
