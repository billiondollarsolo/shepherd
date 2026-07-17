# Structured-Protocol Chat Transport — Implementation Plan

**Goal.** Give chat-capable agents a t3code-class chat experience — **dynamic model
lists, dynamic slash commands, structured tool cards, and real audited approvals** —
by running them over their **structured protocol** instead of scraping the PTY /
tailing a transcript, while keeping the entire Shepherd platform (agentd security
isolation, multi-node orchestration, RBAC, audit, the console UI).

**Chosen scope (confirmed):** *Add a structured-protocol transport; keep the
platform.* Not a rewrite; not a fork.

---

## Decision: agentd-native (Go), NOT Effect / t3code packages

Verified by two deep audits (Shepherd's transport seam + t3code's Effect packages):

1. **agentd already ships a complete, unit-tested ACP JSON-RPC client in Go**
   (`agentd/internal/acp/{acp,client,events}.go` + `agentd/internal/session/acp_session.go`).
   It's reachable via `Spec.Mode == "acp"` and already does handshake, `session/new`,
   `session/prompt`, streaming deltas, `tool_call`/`tool_call_update`, plan/usage/model
   telemetry, and **structured approvals** (`session/request_permission`). What's off
   is the *orchestrator's* choice to select ACP (`acpLaunchCommand` returns `null`),
   because of a headless-auth dead-end.
2. **agentd exposes no raw-stdio piping primitive** to the orchestrator (only PTY
   frames, one-shot `exec`, and TCP-to-loopback tunnels). So a TS/Effect protocol
   client cannot drive a remote-node agent's stdio — the client must live in agentd,
   co-located with the agent process.
3. **Effect footprint is a liability:** t3code pins `effect@4.0.0-beta.78` (pre-1.0
   beta) *with a local patch*, on `effect/unstable/rpc`. Not worth importing for a
   transport we already have in Go.
4. **t3code doesn't solve our hard problem** (headless auth is an explicit non-goal;
   it co-locates agent+server on an already-authed host) and drives Claude via the
   native CLI, not ACP.

**What we take from t3code:** protocol *semantics* as a reference, and the fact that
both protocols ship machine-readable schemas — Codex: `codex app-server
generate-json-schema` / `generate-ts`; ACP: published `schema.unstable.json` — from
which we can generate/curate Go bindings.

---

## Per-agent structured path (they differ)

| Agent | Structured transport | Dynamic models? | Structured tools/approvals | Auth |
|---|---|---|---|---|
| **Codex** | `codex app-server` (JSON-RPC; has `model/list`) | ✅ `model/list` | ✅ | `codex login` → `~/.codex/auth.json` |
| **Claude** | `claude --print --input-format stream-json --output-format stream-json` | ❌ (no enumeration exists anywhere — aliases + free-text stay) | ✅ tool calls + approvals + streaming | `claude` login → `~/.claude` |
| **Antigravity** | agy structured mode (already tail transcript; `agy models` dynamic) | ✅ `agy models` | (transcript today; evaluate agy protocol) | terminal login |
| **Gemini / Cursor** | ACP (`--experimental-acp` / `cursor-agent acp`) — the EXISTING Go client already speaks this | ✅ ACP `availableModels` | ✅ (already) | headless-auth blocker |

The headline **dynamic-model** win is Codex (`model/list`) + Antigravity (`agy
models`) + ACP agents. **Claude has no model list anywhere** — its win is structured
tool cards + real approvals + streaming, not models.

---

## The real work (3 things, none of which is "build a transport")

1. **Widen the agentd→orchestrator channel.** Today the ACP client's rich data
   (structured tool calls, model list, `availableCommands`, structured approvals) is
   collapsed to terminal ANSI + a status string + `{chat:{role,text}}`. Extend
   `events.go`/`parseSessionUpdate`, add proto frames / structured fields, add
   orchestrator TS handlers, and render them in the web chat.
2. **Solve headless auth** via **PTY-login-first, structured-for-chat**: an agent's
   `~/.<home>` is authed once through a normal PTY session (already works); structured
   sessions reuse that same authed runtime-user home. Detect unauthed → route to PTY
   (shows the login); authed → allow structured.
3. **Add the two missing Go clients** (Codex app-server, Claude stream-json) alongside
   `internal/acp`, selected by the same `Spec.Mode` switch (`manager.go:80`).

---

## Phases

### Phase 0 — Spike (de-risk): prove the existing ACP client end-to-end
Turn on `mode:'acp'` for one **already-authed, ACP-capable** agent behind a flag and
confirm chat + approvals flow over today's channels. Establishes the plumbing works
before we widen it. (Needs an ACP agent that's authed on the node — gemini or
cursor-agent; pick whichever we can auth.)
**Exit:** a real ACP session renders in the chat view + approve/deny round-trips.

### Phase 1 — Widen the structured channel (protocol + orchestrator + web)
- agentd: carry structured **tool calls** (name, args, status, diff), **model list +
  current model**, **availableCommands**, and **structured approvals** to the
  orchestrator (new proto frame or structured status fields; do NOT overload chat text).
- orchestrator: TS handlers + event-log shapes for the above.
- web: render structured tool cards, a **dynamic** model list, a **dynamic** slash
  menu, and a first-class approve/deny that hits a structured endpoint (not stdin).
**Exit:** the existing ACP agent shows dynamic models/commands + structured tools/approvals in chat.

### Phase 2 — Codex app-server Go client
- New `agentd/internal/codexappserver` Go client (JSON-RPC over ndjson), schema from
  `codex app-server generate-json-schema`. Wire via `Spec.Mode == "codex-app-server"`.
- Map its events onto the Phase-1 structured channel; implement `model/list` +
  set-model + approvals.
**Exit:** Codex chat shows its **real dynamic model list** + structured tools/approvals.

### Phase 3 — Claude stream-json Go client
- New Go client for `claude --print --*-format stream-json` (structured messages +
  tool_use/tool_result + permission prompts). Wire via `Spec.Mode == "claude-stream"`.
- Models stay aliases+free-text (no enumeration exists); the win is structured chat.
**Exit:** Claude chat shows structured tool cards + real approvals + streaming.

### Phase 4 — Auth routing + flip the switch
- PTY-login-first detection: unauthed runtime-user home → route to PTY (login shows);
  authed → prefer structured for chat-capable agents. Re-enable selection in
  `acpLaunchCommand` / transport picker (`session-rest-service.ts`).
- Keep PTY as explicit fallback + the Terminal view (always available).
**Exit:** starting a chat-capable agent uses the structured transport when authed, PTY otherwise, transparently.

### Phase 5 — Consolidate
- For structured agents, the protocol is authoritative for chat/status; retire
  transcript-tailing for them (keep as fallback). Keep PTY terminal view.
- Docs + tests + per-node capability advertisement.

---

## Non-goals / guardrails
- No Effect dependency; no t3code vendoring; no rewrite.
- PTY transport + Terminal view remain first-class (fallback + real terminal + login).
- No proto churn we can avoid: prefer extending existing status/event frames; add a
  new structured frame only where the data genuinely doesn't fit.
- Every phase ships behind a flag and is independently revertible.

## Key files (from the audits)
agentd: `internal/acp/{acp,client,events}.go`, `internal/session/{acp_session,acp_bridge,acp_runner,manager}.go`, `proto/proto.go`, `internal/server/server.go`.
orchestrator: `sessions/agent-launch.ts` (`acpLaunchCommand`), `sessions/session-rest-service.ts`, `index.ts` (`agentdLaunch`), `nodes/agentd/agentd-client.ts`, `hooks/endpoint.ts`.
web: `features/chat/ChatPanel.tsx`, `features/chat/chatTimeline.ts`, `features/chat/chatCapable.ts`.
