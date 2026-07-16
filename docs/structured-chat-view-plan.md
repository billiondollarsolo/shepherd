# Structured Chat View — Implementation Plan

> **Status:** Phase 0 shipped · Phases 1–3 proposed · **Scope:** `agentd` + `apps/orchestrator` + `apps/web` + `packages/shared`
> **Authored:** 2026-07-16 · **Method:** multi-agent research (t3code, Claude Code/SDK/ACP, opencode, Shepherd codebase) → skeptic verification → synthesis. All feasibility claims verified SOLID; all file references verified against the tree.

---

## Context

Shepherd is an **enterprise web console that supervises coding agents running on remote nodes** (via `agentd` over an authenticated tunnel). Today each agent is exposed as a raw **terminal (PTY)** in the browser. The ask: offer a **ChatGPT/Claude-style structured chat view** for agents that support it — like [t3code](https://github.com/pingdotgg/t3code) — with a clean, enterprise feel.

**The key finding: this is ~70% built already.** The codebase already ships:

- `packages/shared/src/agentEvents.ts` — the **F5 `AgentEvent` union** (the structured taxonomy: `tool.started/updated`, `usage.updated`, `plan.updated`, chat messages, …). This is the contract the chat view, control plane, and telemetry all consume.
- `agentd/internal/session/acp_session.go`, `acp_runner.go`, `acp_bridge.go` — a working **ACP (Agent Client Protocol) runtime** on the node (`Spec.Mode == "acp"`), alongside the default PTY runtime.
- `apps/web/src/features/chat/ChatPanel.tsx` — a chat tab that already renders transcripts for Claude / Codex / OpenCode / Gemini.
- `packages/shared` `SessionPermissionModeEnum` (`default | acceptEdits | plan | autonomous`) mapped to per-agent CLI flags.
- `docs/roadmap.md`: **P3 — Structured chat view (read-side projection)** is already scoped, with the governing **doctrine: "terminal is the control surface + source of truth; chat is read-mostly."**

**So this plan is "finish and harden an existing capability," not "build a new one."** The remote-node question ("can a web UI over remote nodes even do this?") is already answered by Shepherd's own PTY-and-status-over-tunnel transport — which is exactly the part t3code *punts on* (t3code runs agents on the user's local machine; its cloud is auth/relay only).

### The gap today

Structured chat reaches the browser **flattened and on a poll**: the node POSTs whole `{role,text}` messages to the orchestrator hook (`apps/orchestrator/src/hooks/opencode-chat.ts` → event log → Postgres), and the web read the event log via REST. **Phase 0 (below) made that feel live over the existing status channel;** the remaining work is a real **live structured event channel** that carries the full F5 granularity (deltas, tool lifecycle, diffs, approvals) — not just message bubbles.

### Agent support reality

| Agent | Chat today | Ceiling | Path |
|---|---|---|---|
| **Gemini** | ✅ | **Full ACP** (streaming, tool cards, hunk diffs, approvals) | native `--experimental-acp` |
| **Claude Code** | ✅ bubble | ACP-adapter / SDK fidelity | `claude-code-acp` adapter or `@anthropic-ai/claude-agent-sdk` |
| **Codex** | ✅ bubble | app-server / JSON fidelity | `codex exec --json` / app-server |
| **OpenCode** | ✅ bubble | hook-assembled | `hooks/opencode-chat.ts` |
| grok · aider · cursor-agent · amp · terminal · dev | ❌ | — | **terminal-only by nature** |

**Gemini/ACP is the only path that is truly live + full-fidelity today.** Everything else is whole-message bubbles at turn boundaries, and ~6 agents are terminal-only.

---

## Doctrine (non-negotiable)

1. **Terminal is the floor and the source of truth.** Chat is a *sibling* view offered where the agent supports it; it is never a prerequisite to use an agent, and it never replaces or demotes the PTY. For terminal-only agents the chat toggle is simply not offered.
2. **Reuse the proven transport shape; don't invent a wire protocol.** The live event channel clones Shepherd's existing **status fan-out** end-to-end (agentd `statusSub`/`startStatusForwarder`/`statusControl` → orchestrator `StatusChannel` in `live-channels.ts` → web `useStatusWebSocket`). The event payload is the existing **F5 `AgentEvent` union**; ACP's vocabulary maps onto it.
3. **Structured input only for structured sessions.** A true chat composer routes to ACP `session/prompt` + structured `request_permission`. It must **not** ship `y/n`-into-PTY dressed up as an audited approval.
4. **Enterprise-first framing.** The point of structured chat is not decoration — it's *auditable transcripts, tool-call authorization gates, and diff review*. Every phase preserves that.
5. **AA + reduced-motion + a11y** on all new UI, per the elite-UI standard already in `apps/web`.

---

## Phase 0 — Make chat feel live (✅ SHIPPED)

**Goal:** kill the perceived lag with zero new transport.

- `apps/web/src/features/chat/ChatPanel.tsx` invalidates the events (+plan) query the instant a **live status frame** lands for the session, via the already-open status channel (`LiveStatusTransitionContext`). Turn boundaries (running → awaiting_input/done) are exactly when new messages land, so the transcript updates near-instantly.
- `apps/web/src/data/queries.ts` `useSessionEvents`: baseline poll 5s → 2s + refetch-on-focus as a streaming backstop.

**Validation (done):** web `tsc`/eslint + 541 unit tests, vite build; deployed. **This is the highest ROI-per-line change and required no `agentd`/proto/orchestrator work.**

---

## Phase 1 — Live structured event channel + the Gemini/ACP flagship

**Goal:** prove the premium experience — live streaming, tool cards, diff review, one-click approvals — **end-to-end on one agent (Gemini over ACP)** by building the real transport once.

**Precondition — close the F6 live gate first.** The ACP client spine is core-done but has an **open live-validation gate**: no one has confirmed an end-to-end Gemini ACP session *streaming on a real remote node*. Do this before building UI on top.

| # | Task | Where |
|---|------|-------|
| 1.1 | **agentd: an `EventSub` fan-out** mirroring `statusSub` — a new proto frame/Op + `startEventForwarder` emitting the full F5 `AgentEvent` union that the ACP bridge already produces internally. | `agentd/internal/server/server.go` (clone `statusSub`/`startStatusForwarder`/`statusControl`), `agentd/proto/*` (new frame type/Op), `agentd/internal/session/acp_bridge.go` (surface F5 events) |
| 1.2 | **shared: a WS envelope contract** for events, mirroring `StatusUpdateMessage`. The F5 union already exists — this is the transport wrapper only. | `packages/shared/src/agentEvents.ts` (reuse), new `…/eventWsProtocol` contract |
| 1.3 | **orchestrator: event ingest + fan-out** mirroring `StatusMap`/`StatusChannel`, plus a `/ws/events` server mirroring the PTY WS server (auth via the same `ws-auth`). | `apps/orchestrator/src/live-channels.ts`, new `apps/orchestrator/src/sessions/events-ws/events-ws-server.ts` (clone `sessions/pty-ws/pty-ws-server.ts`), `apps/orchestrator/src/index.ts` (mount) |
| 1.4 | **web: a `useEventsWebSocket` hook** mirroring `useStatusWebSocket`/`usePtyWebSocket`, feeding a **client reducer** that folds the F5 stream into a timeline (messages, tool cards, diffs, plan, usage). `ChatPanel` consumes the live stream instead of the polled event log. | `apps/web/src/features/chat/useEventsWebSocket.ts` (new), `…/chatTimeline.ts` reducer (new), `ChatPanel.tsx` |
| 1.5 | **Structured composer + approvals.** For a true ACP session, the composer routes to ACP `session/prompt` (`acpPrompt`), and a **tool-call approval UI** surfaces `session/request_permission` with the exact option IDs → one-click Approve / Deny (recorded). Replaces the PTY-stdin shim for ACP sessions. | `agentd/internal/session/acp_session.go` (`acpPrompt`, `acpAwaitPermission`), `ChatPanel.tsx` composer, new `ApprovalCard` |
| 1.6 | **Tool cards + diff review UI.** Render `tool.started/updated` as collapsible tool cards; render ACP hunk-level diffs with the existing diff viewer (`features/center/DiffTab`) inline. | `apps/web/src/features/chat/*` |

**Validation:** the F6 live gate — drive a real Gemini ACP session on a node and assert streamed `agent_message_chunk` / `tool_call` / `request_permission` render live; unit tests for the timeline reducer (pure); Playwright e2e asserting a message streams in, a tool card appears, an approval round-trips and is recorded in the audit log; reconnect test (network blip must not drop the session — event-sourced replay); AA/reduced-motion on the new chat UI.

---

## Phase 2 — Generalize the live channel to transcript-tailed agents

**Goal:** carry the F5 stream **live** for Claude / Codex / OpenCode at bubble-plus fidelity — same transport as Phase 1, cheaper per-agent parsing.

| # | Task | Where |
|---|------|-------|
| 2.1 | Route the existing transcript-tail / hook assemblers through the Phase 1 `EventSub` channel instead of the HTTP-hook-then-poll path, so Claude/Codex/OpenCode chat is live too. | `agentd/internal/session/*` (transcript tailers), `apps/orchestrator/src/hooks/opencode-chat.ts` |
| 2.2 | A per-agent **adapter registry** (t3code's `ProviderAdapterRegistry` pattern; your F5 union is the normalized target) so each agent's transcript/app-server quirks normalize into F5 in one contained place. | `agentd/internal/session/*`, documented in `docs/agent-integration-matrix.md` |
| 2.3 | Chat/terminal **view toggle** finalized: chat is the default *where supported*, terminal one click away; toggle absent/disabled for terminal-only agents. | `apps/web/src/features/…/SessionPane` + tab chrome |

**Validation:** e2e per transcript agent (message appears live at a turn boundary); confirm terminal-only agents show no chat toggle; audit-log entries for each agent's messages.

---

## Phase 3 — Fidelity upgrades (opt-in, where payoff justifies maintenance)

**Goal:** raise Claude/Codex from bubbles to true streaming + granular tool cards **only where the UX win is worth the adapter cost.**

| # | Task | Where |
|---|------|-------|
| 3.1 | **Claude at ACP/SDK fidelity** via Zed's `claude-code-acp` adapter or `@anthropic-ai/claude-agent-sdk` (`query()` typed messages, `canUseTool` → real approvals, `resume`). Gate on Claude Code ≥ the required version. | `agentd/internal/session/*` (new Claude ACP/SDK runner) |
| 3.2 | **Codex at JSON fidelity** via `codex exec --json` / `codex app-server`. Note the flag drift (`--experimental-json` → `--json`) — pin per version. | `agentd/internal/session/*` |
| 3.3 | **Addressable turns** (roadmap P4) — deep-link/scroll to a specific turn; cross-reference audit entries ↔ transcript. | web + `event-read-service.ts` |

**Validation:** compare against the raw TUI for the same task; confirm approvals are structured (not PTY `y/n`); version-matrix tests.

---

## Enterprise layer (woven across Phases 1–3, but called out)

This is the actual selling point for a supervision product — a raw terminal is a *liability* here:

- **Auditable transcripts.** The F5 event log is a *queryable* record ("which tools ran, on which files, who approved") — already write-behind to Postgres via `event-read-service.ts`. Structured chat makes that store meaningful for compliance.
- **Tool-call approval as an authorization gate.** ACP `request_permission` / SDK `canUseTool` → a structured Approve/Deny with a recorded decision and actor. Replaces `RespondBar` typing `y/n` into the PTY (neither reliable nor auditable). **Biggest enterprise win.**
- **Diff review before write** — hunk-level accept/reject over ACP.
- **Fleet supervision as cards, not 10 terminals** — F5 already carries `usage.updated` / `tool.*` / `plan.updated`; render agents as readable state cards.
- **Permission modes made legible** — `default|acceptEdits|plan|autonomous` surfaced/enforced in the UI instead of buried in launch argv.

---

## Risks & what NOT to do

**Risks:**
- **Fidelity vs the real TUI** — chat is a projection; some TUIs redraw in ways a normalized stream won't reproduce. *Mitigation: terminal is always one toggle away.*
- **Bubble ≠ streaming** — only Gemini/ACP is truly live today; don't promise token-level streaming for Claude/Codex in Phase 1/2.
- **ACP over a network is the least battle-tested bit** — every third-party ACP impl runs the agent as a *local* stdio subprocess; Shepherd's tunnel de-risks it, but **validate the F6 live gate before building on it.**
- **Per-agent adapter drift** — formats change across versions (Claude behaviors gated on version; Codex flag rename). Contain it in the adapter registry; it's ongoing cost.
- **Claude ≠ native ACP** — needs Zed's adapter over the SDK (an extra dependency).

**Do NOT:**
- Build a new bespoke wire protocol — clone the status fan-out; reuse the F5 union + ACP vocabulary.
- Give *every* agent a chat view — grok/aider/cursor-agent/amp/terminal/dev stay terminal-only by design.
- Remove or demote the PTY terminal — it's the universal floor and fidelity fallback.
- Ship `y/n`-into-PTY as an "audited approval" — do the real `request_permission` round-trip or label it best-effort.
- Copy t3code's execution model — its local-agent assumption is the thing Shepherd's remote-node architecture already surpasses.

---

## MVP recommendation

**Phase 0 (done) + Phase 1 (Gemini/ACP flagship)** is the shippable MVP: it proves the premium, enterprise-grade chat experience on one agent by building the live transport once, then Phases 2–3 generalize and deepen. Don't start Phase 1 UI until the F6 live gate is green on a real node.

---

## Appendix — verified references

**Codebase (verified present):** `packages/shared/src/agentEvents.ts`; `agentd/internal/session/{acp_session,acp_runner,acp_bridge}.go`; `agentd/internal/server/server.go` (`statusSub`, `startStatusForwarder`, `statusControl`); `apps/orchestrator/src/live-channels.ts`; `apps/orchestrator/src/sessions/pty-ws/pty-ws-server.ts`; `apps/orchestrator/src/hooks/opencode-chat.ts`; `apps/orchestrator/src/events/event-read-service.ts`; `apps/web/src/features/chat/ChatPanel.tsx`; `apps/web/src/features/tree/{useStatusWebSocket,statusWsProtocol}.ts`; `docs/roadmap.md` (P3/F5/F6), `docs/agent-integration-matrix.md`.

**External (cited):** t3code — github.com/pingdotgg/t3code, t3.codes (MIT; Node WS server wrapping `codex app-server`; local execution + relay-only cloud; Codex-first). Agent Client Protocol — agentclientprotocol.com, github.com/zed-industries/agent-client-protocol (`session/prompt`, `session/update`, `session/request_permission`). Claude Code — `claude -p --output-format stream-json`, `@anthropic-ai/claude-agent-sdk` (`query()`, `canUseTool`, `resume`), Zed `claude-code-acp` adapter. opencode — github.com/sst/opencode (client/server: server runs the agent, thin clients connect — the closest precedent to web-UI + remote + chat). Codex CLI — github.com/openai/codex (`exec --json`, app-server). Gemini CLI (native ACP).

*Generated from a verified multi-agent research pass; every task names concrete files and the transport/protocol to reuse.*
