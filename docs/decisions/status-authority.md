# Decision: Status authority (screen, transport, done / unseen)

Status: Accepted (locked with master improvement plan Pass F)  
Date: 2026-08-01  
Plan: [`master-improvement-plan.md`](../master-improvement-plan.md) (H0.4; D4, D9, D10, D11)

## Context

Shepherd derives session status from multiple sources: structured transports
(Chat / ACP / stream), lifecycle hooks, transcript tails, PTY activity, and
(planned) TOML screen-manifest detection on the live PTY bottom buffer. Without
an explicit arbitration model, sources fight, permission UIs miss
`awaiting_input`, and Chat mode can thrash when the TUI still shows chrome.

Product decisions D4, D9, D10, and D11 are **locked** (2026-08-01). This ADR
records them as implementation requirements.

## Decision

### 1. Terminal mode precedence (D4)

When a session runs in **Terminal** mode (native PTY, not structured Chat
transport ownership), status arbitration uses this order (highest first):

1. **Lifecycle authority** — if active (e.g. a complete per-session hook plugin
   actively reporting, such as OpenCode’s seeded plugin)  
2. **`visible_blocker` screen** — screen-manifest match that asserts a visible
   blocker (permission / question UI)  
3. **Transcript / hooks partial** — incomplete integration signals (tokens,
   coarse lifecycle, session-id style hooks that do not fully author blocked)  
4. **PTY activity** — recent output / process activity  
5. **Idle fallback** — no stronger classification

Notes:

- Screen detection runs inside `agentd` on a parsed bottom-buffer snapshot (D1).  
- Manifest rules marked `skip_state_update` must not clobber wire state (they
  remain available for explain / diagnostics).  
- In Terminal mode, a `visible_blocker` screen match may override non-blocked
  partial integration state (Herdr-like behavior under D4).

### 2. Chat / ACP / stream mode (D11)

When a session runs under a **structured transport** (Chat mode, ACP, or
stream drivers such as `claude-stream` / `codex-app-server`):

- **Transport owns status.** The structured path is the sole lifecycle
  authority for the wire `Status` enum.  
- **Screen is diagnostic-only** — snapshots and rule matches may appear on
  `status.explain` / fixtures; they must **not** drive live status merge.  
- **`visible_blocker` must not override** Chat / ACP / stream status.

This avoids dual-source thrash when the agent still paints a TUI under a
structured driver.

### 3. Done and unseen-idle semantics (D9)

| Concept | Wire / product rule |
| --- | --- |
| **`done`** | **Session end only.** Not used for turn-complete. Web Push on `done` stays session-end only. |
| **Turn complete** | Projects to **`idle`**. |
| **Unseen finished work** | Stay on wire **`idle`**; set **`unseenIdle` metadata** + UI attention (badge / attention list). Do **not** remap unseen idle to wire `done` (Herdr’s unseen→done is explicitly rejected). |

### 4. Screendetect default (D10)

Screen-manifest detection is **default on** after the fixture and authority
gate for first-wave agents (claude, codex, opencode, grok, antigravity hard
fixtures + Chat non-override). Operators kill-switch with
`FLOCK_SCREENDETECT=0|false|off|no`. Live multi-agent soak remains recommended
but is not required to keep the product default.

## Consequences

- Implementers wire status merge to this ADR; do not re-open Pass F in feature PRs.  
- Chat-mode sessions remain stable when screendetect is later enabled globally.  
- Operators debug wrong dots via explain APIs without changing authority.  
- Matrix and architecture docs reference this file for authority column intent.  
- Manifest provenance and Apache-2.0 attribution: [`herdr-attribution.md`](../herdr-attribution.md).

## Revisit when

- Pass F is amended in `master-improvement-plan.md` with an explicit product
  decision change; or  
- a new structured transport requires a documented exception (still must not
  dual-author wire status without an ADR update).
