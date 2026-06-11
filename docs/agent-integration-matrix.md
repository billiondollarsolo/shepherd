# Agent integration matrix

How Flock derives live supervision signals for each supported coding-agent CLI —
what we capture, the mechanism, and the known gaps. This is the authoritative
reference for "how well do we work with agent X." Verified against real on-disk
transcripts/hooks (last reviewed 2026-06-05; **transport/Chat/trust + live
validation updated 2026-06-08 — see the section immediately below**).

Flock's model: **leverage what the agent already produces on the node** — its
transcript files (tailed by `flock-agentd`) and/or its lifecycle hooks (forwarded
to `POST /api/hooks/:id`). The orchestrator normalizes everything into the shared
`Status` enum + telemetry (rides the status WS → bottom bar + grid + sidebar) +
the `plan` event artifact (`/plan`).

## Transport, Chat & Trust (updated 2026-06-08)

Three additions supersede parts of the older matrix below:

**Transport is auto-selected per agent (no user toggle).** Flock picks the path
that yields a structured **Chat** log while preserving the best interaction:
- **claude / codex / opencode → native PTY.** Native TUI; Flock tails the
  transcript (claude/codex) or hook stream (opencode) for status/telemetry.
- **gemini → ACP** (`gemini --experimental-acp`) over stdio — no live transcript,
  so ACP captures its conversation as structured messages. (Chosen over scraping
  gemini's OTel: pretty-printed concatenated JSON interleaved with internal
  sub-calls — fragile + noisy vs the clean ACP stream.)
- **grok → native PTY.** VERIFIED 2026-06-08: grok does NOT speak ACP — `grok agent
  stdio` is a JSON line protocol but ignores ACP's `initialize` (no response;
  gemini answers it). So grok runs native PTY with status from its Claude-compatible
  hooks. It has no transcript either → **no Chat source** (status works, chat is a
  gap until grok exposes a transcript or real ACP).

**Chat tab** (per-session structured conversation) fills from:
- transcript → chat for **claude** (`claudeLineToChat`) and **codex**
  (`codexLineToChat`, `event_msg.agent_message`); whole messages POSTed to the
  hook endpoint → event log → web.
- the ACP stream for **gemini** (agentd posts user/assistant/tool messages;
  assistant text is flushed when the prompt turn RETURNS — ACP agents don't send a
  turn-complete update).
- **OpenCode ✅** (2026-06-08) — the plugin now forwards `message.part.updated` and
  `OpenCodeChatAssembler` (hooks/opencode-chat.ts) reconstructs whole messages by
  message id + role, flushed on `session.idle` → `chat` events. Validated live
  (user + assistant).
- **grok ❌** — native PTY, no transcript/ACP → no chat source (status only).

**Folder-trust is pre-accepted at launch** (`agentd .../session/trust.go`,
`ensureFolderTrust`) so a session starts READY rather than blocked on an
onboarding/trust prompt (which also ate the first piped input): claude
`~/.claude.json projects[cwd].hasTrustDialogAccepted=true`, gemini
`~/.gemini/trustedFolders.json {cwd:"TRUST_FOLDER"}`, codex `config.toml
trust_level` (already trusted). Non-destructive merge.

**Live-validation status (2026-06-08, driving real prompts via the PTY WS):**
gemini (ACP) ✅ end-to-end (user+assistant); claude (transcript) ✅ end-to-end;
**opencode ✅ end-to-end (user+assistant via the parts assembler)**; codex
mechanism-validated (status/tokens/model + user-chat live; `agent_message` format
confirmed in real rollouts — headless TUI drive of a clean assistant turn is flaky,
not a product issue); **grok ✅ native PTY live (status via hooks); not ACP, so no
chat**. So Chat is proven for claude/codex/gemini/opencode; grok has status only.

## Capability matrix

✅ captured · ⚠️ partial / wired-but-not-flowing · ❌ missing

> Note: the columns below describe each agent's **status** path. Transports differ
> by SIGNAL and don't all ride the same channel:
> - **Gemini**: its **chat** rides ACP (structured messages — see above), but its
>   **status** rides Gemini v0.26+ **hooks** (footnote 5), not ACP. Tokens/model/
>   context%/plan are ❌ (hooks carry status only; needs a transcript tailer).
> - **Grok**: **native PTY**, status via Claude-compatible **hooks** — NOT ACP, and
>   no chat transcript (status only).
>
> The **Chat** capability is summarized in the section above.

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
