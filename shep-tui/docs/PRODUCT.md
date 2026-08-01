# Shep-TUI — Elite Product Plan

**Status:** Authoritative product + engineering plan  
**Audience:** humans and agents building `shep-tui`  
**Companion:** [`../flock/docs/architecture.md`](../../flock/docs/architecture.md), [`../flock/docs/roadmap.md`](../../flock/docs/roadmap.md), [`../flock/docs/design-tokens.md`](../../flock/docs/design-tokens.md), [`../flock/docs/flock-agentd-design.md`](../../flock/docs/flock-agentd-design.md), [`NODES.md`](NODES.md), [`KEYBINDS.md`](KEYBINDS.md)  
**Last updated:** 2026-07-11 (Phase 5 elite-finish plan added)

---

## 0. How to use this document

This is the **whole product**, not a spike outline. Work it like Flock’s elite roadmap:

1. Respect **§2 Invariants** — they are merge gates.
2. Phases **0–4** built the foundation (Release DoD). **Phase 5** is the current critical path to elite UX.
3. One task ≈ one branch ≈ one PR. Prefer TDD against the task’s success criteria.
4. Update this doc’s checkboxes and the capability matrix (§6) in the same PR.
5. Never ship nested-terminal or status UX that fails live validation against real agents (Claude Code, Codex, OpenCode at minimum).

**Product decisions (locked):**

| Decision | Choice |
| --- | --- |
| Primary product | **Standalone paddock** — local `flock-agentd` only; **no SSH / no orchestrator required** |
| Optional multi-machine | Fleet mode via Flock orchestrator (SSH nodes managed there, not required for elite local) |
| Process ownership | **Never the TUI** — agentd owns PTYs |
| Home surface | **Paddock** (sidebar · pens · status) — not an attention-first board |
| Supervision density | **Named pens (1–4 agents)** with layout presets |
| Stack | **Go + Charm** (Bubble Tea, Lip Gloss, Bubbles; Huh for forms) |
| Feel | **Flock paddock** — calm density, affirmative status words, one accent, keyboard-first |
| Ambition | **Elite local supervision** + TUI superpowers; web parity where the medium allows |

---

## 1. Vision

**Shep-TUI** is a single static binary that shepherds CLI coding agents in a **paddock** — pens of 1–4 agents, live **Idle / Working / Needs you**, durable PTYs in `flock-agentd`.

**Standalone is the product.** Install agentd, run `shep-tui`, supervise agents on this machine. Fleet/orchestrator/SSH is an optional second path, never a prerequisite for elite local UX.

Where the web app wins (PWA, phone, browser screencast, pixel chrome), the TUI wins elsewhere:

- **Latency and muscle memory** for operators who live in the shell
- **Multi-pane pen density** without window managers
- **Scriptable headless ops** (list, wait-for-status, inject, export)
- **Zero Electron / zero browser** on air-gapped or constrained hosts
- **Same durable sessions** — close the TUI; agents keep working
- **Optional** fleet attach when a Flock deploy already exists

**One-sentence identity:**  
*A terminal paddock that understands agents — standalone first, fleet optional.*

### Honest baseline (as of last update)

| Layer | Reality |
| --- | --- |
| Phases 0–4 | **Shipped at Release DoD** — durable PTY, paddock shell, palette, shell drawer, splash, CLI |
| UX grade | **M-Elite-Standalone shipped** — launch wizard, named multi-pen, Agents tree + badges, git commit, CLI launch/wait; E12/E16–E22 still optional |
| Standalone | **Default and full local caps** (launch/git/files/pens/handoff/chat/shell). **No cost**: the agentd protocol has no cost field, so `Caps.Cost` is false and every cost surface is hidden. |
| Fleet | **View-only today**: list/watch/attach/close. `Caps.Launch`/`ShellDrawer`/`Git`/`Files`/`Handoff`/`Chat`/`Audit` false — the palette, the header keys and the empty state all hide what it cannot do. `Caps.Cost` true (the `/ws/status` frame carries `costUsd`). |

### Strategic layers

| Layer | Name | Intent |
| --- | --- | --- |
| **L0** | Foundation | Binary, config, dual backend, VT pen engine, status spine, auth |
| **L1** | Supervision elite | Pens, sidebar attention, palette, telemetry, notifications, full tree CRUD |
| **L2** | Per-session power | Respond bar, dual chat+PTY, git/PR, handoff, steer/inject, shell drawer |
| **L3** | Fleet power | Multi-orchestrator profiles, run-N-compare, cross-node ops, governance views |
| **L4** | Platform polish | Themes, keybind DSL, plugins, headless CLI, packaging, docs, a11y |

Web roadmap Layer 2 items that are **web-only** (screencast canvas, phone PWA chrome) stay out of TUI scope; TUI owns equivalent *intent* where possible (open URL, notify, approve from keyboard).

---

## 2. Invariants (never violate)

1. **Any agent works.** Raw PTY is the universal session path. Structured transports (ACP, hooks, transcripts) enrich status/chat/control; they never gate “can I attach and type.”
2. **The node is the source of truth; the TUI is a viewer.** Sessions live in `flock-agentd`. Killing the TUI must not kill agents. Local mode still uses agentd — the TUI does **not** own long-lived PTYs in-process as the product model.
3. **One status vocabulary.** Wire and UI use Flock’s shared model:  
   `starting` · `running` · `awaiting_input` · `idle` · `done` · `error` · `disconnected`  
   Display labels are always affirmative: **Starting · Working · Needs you · Idle · Done · Error · Disconnected.** Never invent parallel words (“busy”, “waiting”, blank idle).
4. **Detach always works.** There is always a documented host chord that returns control from a focused agent TUI to Shep-TUI chrome, even when the agent is in alt-screen / raw mode / mouse tracking.
5. **Fleet and local share one UX.** Mode is a transport detail. Tree, pens, status, palette, and keybinds behave the same; only capabilities that truly differ (multi-node registry, web push backend, team authz) degrade gracefully with clear chrome.
6. **No secret in the clear.** Tokens, agentd secrets, and passwords live in `0600` config/keyring paths; never logged; never embedded in shell history helpers without redaction.
7. **Calm density over spectacle.** One accent; small status glyphs; no rainbow dashboards; motion only for “Needs you” (and respects `NO_COLOR` / reduced-motion prefs).

### Explicit non-goals

- Replacing the web app or phone PWA
- Reimplementing per-session Chrome screencast inside the terminal (optional: open external browser / print CDP URL)
- Becoming a general tmux replacement for non-agent workflows
- Local-first SQLite product pivot that abandons agentd
- Making ACP the only transport
- Pixel-perfect clone of the React layout — borrow structure and language, not CSS

---

## 3. Relationship to Flock

```
                         ┌──────────────────────────────┐
                         │         shep-tui (Go)         │
                         │  Charm UI · pens · VT · CLI   │
                         └───────────────┬────────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    │ mode: fleet              mode: local     │
                    ▼                          ▼
           orchestrator REST/WS         flock-agentd unix sock
           auth · tree · status ·       framed proto (v1)
           pty · git · events ·         open/list/status/pty
           pens · push registry
                    │                          │
                    └────────────┬─────────────┘
                                 ▼
                        flock-agentd (per node)
                           raw PTYs · scrollback
                           status · metrics · ACP
                                 ▼
                        claude / codex / opencode / …
```

| Mode | Activation | Durability | Multi-node | Status path |
| --- | --- | --- | --- | --- |
| **Fleet** | `FLOCK_URL` + token (or profile) | Full Flock (any client, any device) | Yes | Orchestrator live status WS (+ hooks) |
| **Local** | default; `FLOCK_AGENTD_SOCKET` | Survives TUI exit if agentd up | This host only | Agentd `status` control frames (+ local transcript tails inside agentd) |

**Hybrid is not “sometimes spawn PTY in the TUI.”** Hybrid is “sometimes skip the orchestrator and speak agentd’s protocol.”

### Backend interface (conceptual)

```text
Backend
  Tree() / WatchTree()
  WatchStatus() -> StatusUpdate
  OpenPty(sessionID, cols, rows) -> PtyStream   // N concurrent for pens
  ResizePty / ClosePty / WritePty
  CreateSession / TerminateSession / Handoff
  Git* / Diff* / Events* / Files* / Pens*       // fleet-rich; local subset
  NodeMetrics / ListAgents
```

UI and pen engine depend only on `Backend`. Fleet and Local are adapters.

### Upstream Flock work this product may require

These live in `../flock` when the TUI cannot be elite on public APIs alone:

| ID | Change | Why |
| --- | --- | --- |
| **U1** | CLI-friendly auth: PAT / API token / device login usable on REST + WS | Cookie-only blocks non-browser clients |
| **U2** | Stable OpenAPI or exported JSON Schema for REST + live WS frames | Prevent client drift; generate Go types |
| **U3** | Optional short-lived WS tickets bound to token | Avoid putting long-lived secrets on every socket URL |
| **U4** | Local “single-user” agentd feature parity for pens layout persistence | Local mode pen geometry without Postgres |
| **U5** | Structured respond/steer routes fully wired (Flock roadmap P1/P2) | TUI RespondBar needs server round-trip |
| **U6** | Event stream API suitable for chat projection (F5 taxonomy) | Dual surface chat panel |

TUI development can proceed against local agentd + partial fleet APIs; elite fleet parity tracks U1–U6.

---

## 4. Users and jobs-to-be-done

### Primary users

1. **Solo power operator** — runs many agents on a workstation + build boxes; lives in tmux/SSH; wants Flock durability without leaving the terminal.
2. **Fleet operator** — supervises a self-hosted Flock deploy; jumps in over SSH when the browser is wrong tool (VPN jump, outage, muscle memory).
3. **On-call / away-from-desk** — SSH from phone terminal apps; needs attention inbox + respond, not full IDE chrome.

### Core jobs

| Job | Elite bar |
| --- | --- |
| See who needs me | Sidebar ATTENTION section; Needs you blinks; count in status bar |
| Watch N agents | Pens 1–4 with live VT; focus/input ownership clear |
| Answer a block | Respond without losing pen context; structured approve when available |
| Attach deeply | Full-fidelity PTY focus mode; detach always |
| Leave safely | Exit TUI; agents continue; reattach restores pens + scrollback |
| Direct work | Create/stop/handoff; inject; git commit/push/PR from chrome |
| Operate headless | `shep-tui sessions list --json`; wait for status; CI-friendly |
| Trust cost | Telemetry bar + fleet spend views when data exists |

---

## 5. Domain model

Align with Flock; do not invent a parallel ontology.

```
Profile (tui-local)          which fleet or local agentd
  └─ Backend connection
       └─ Node                 machine (local | ssh)
            └─ Project         workdir / repo root
                 └─ Session    agent instance = PTY (+ optional ACP)
                 └─ Pen*       named group of 1–4 sessions + layout
```

\*Pens are a **presentation + assignment** layer (as in web). Membership and layout persist (fleet: project pens API; local: agentd layout store or `~/.config/shep-tui/pens.json`).

**Session** remains atomic: one agent, one primary PTY stream, one status record, optional structured event stream.

### Status policy (mirror shared)

| Status | Label | Tree loud? | Notify? | Attention rank (0 = top) |
| --- | --- | --- | --- | --- |
| `awaiting_input` | Needs you | yes + blink | yes | 0 |
| `error` | Error | yes | yes | 1 |
| `done` | Done | soft | yes | 2 |
| `idle` | Idle | no | no | 3 |
| `starting` | Starting | soft | no | 4 |
| `running` | Working | soft | no | 5 |
| `disconnected` | Disconnected | dim | no | 6 |

---

## 6. Capability matrix (elite end-state)

Legend: **Y** full · **P** partial / medium-adapted · **W** web-only (TUI offers bridge) · **—** out of product · **L** local-mode subset

| Capability | Web Flock | Shep-TUI elite | Notes |
| --- | --- | --- | --- |
| Durable sessions (agentd PTYs) | Y | Y | Invariant 2 |
| Node → project → session tree | Y | Y | |
| Live status + telemetry | Y | Y | Same labels |
| Pens 1–4 + layouts | Y | Y | Day-one density |
| Drag reorder / pen membership | Y | P | Keyboard + palette + optional mouse |
| Attention board | Y | Y | Attention-first section pinned atop the sidebar |
| Interactive PTY | Y | Y | Multi-pane VT + focus mode |
| Shell drawer (secondary shell) | Y | Y | Extra PTY in project cwd |
| Command palette | Y | Y | `ctrl+k` |
| Configurable keybinds | planned | Y | TUI must nail this |
| Respond to Needs you | Y/P | Y | PTY inject + structured when U5 |
| Structured chat surface | planned | Y | Event projection; terminal remains control truth |
| Steer / model switch / queue | planned | Y | Structured sessions |
| Git status / diff / commit / push / PR | Y | Y | Diff in pane or `$PAGER` |
| File browser on node | Y | Y | Tree + preview |
| Search in files | Y | P | `rg` via backend or local |
| Per-session browser screencast | Y | W | `open` URL / copy CDP; no canvas |
| Web Push | Y | P | Bell + OSC 9/777 + notify-send + ntfy |
| Multi-node SSH fleet | Y | Y | Fleet mode |
| Local single-node | Y | Y | Local mode first-class |
| Auth / multi-user | Y | P | Token auth; RBAC respects server |
| Audit log | Y | Y | Read-only views + filter |
| Run-N-and-compare | planned | Y | TUI comparison layout is a natural fit |
| Cross-node handoff | planned | Y | Fleet |
| Cost governance dashboards | planned | P | Tables + alerts, not heavy charts |
| Headless / scripting CLI | — | Y | **TUI moat** |
| Multiplexer embed (inside tmux) | — | Y | Detect `TMUX`; honest nesting UX |
| Phone PWA | Y | — | Use web; or SSH + TUI |

---

## 7. Product surfaces (IA)

### 7.1 Global chrome

```
┌─ title / connection ─────────────────────────────────────────────┐
│ flock · fleet https://flock.example · user mj · 3 Needs you     │
├─ tree ──────────┬─ main stage ───────────────────┬─ right ───────┤
│ Nodes/Projects  │ Pen | Session tabs               │ Activity     │
│ Sessions+status │ (PTY grid / MC / Chat / Diff)    │ Inbox        │
│ Pens list       │                                  │ Plan         │
├─────────────────┴──────────────────────────────────┴─────────────┤
│ statusline: focus · status · model · tool · ctx% · tok · $ · cpu │
└──────────────────────────────────────────────────────────────────┘
[ overlay: palette | help | dialogs | respond modal ]
```

**Regions:**

| Region | Role | Collapse |
| --- | --- | --- |
| Tree | Navigation + status scan | Icon/glyph rail or hidden (`[`) |
| Stage | Pen grid or focused tools | Always present |
| Right | Activity, inbox, plan, session meta | Toggle (`]`) |
| Statusline | Focused session truth | Always |
| Overlay | Palette, forms, confirmations | Ephemeral |

### 7.2 Stage modes

| Mode | Purpose | Entry |
| --- | --- | --- |
| **Pen** | 1–4 live agent viewports | Default for project |
| **Session Zen** | One session maximized (PTY or chat+PTY split) | `z` / enter focus |
| **Diff** | Source control for focused session | `g d` |
| **Files** | Node/project file browser | `g f` |
| **Compare** | Run-N results (L3) | from orchestration |
| **Settings / Doctor** | Config, keybinds, connectivity | palette |

### 7.3 Pen model (day-one elite, not afterthought)

**Constraints (match web):**

- A Pen holds **1–4** sessions.
- Layout presets: `cols` · `rows` · `grid2x2` · (3-pane: `main+stack`).
- Active pen is per-project; multiple pens per project; “Other agents” unassigned pool.
- Assign/remove via palette, tree keys, or mouse drag when mouse enabled.
- Geometry + membership persist across TUI restarts (backend-appropriate store).

**Input ownership:**

| State | Keys go to | Host chords |
| --- | --- | --- |
| Chrome | TUI | all bindings |
| Pane focused (browse) | TUI (pane switch) | navigation |
| **PTY input mode** | Agent PTY only | **detach only** (+ optional emergency `ctrl+c` triple?) |
| Modal/palette | Overlay | esc closes |

**Detach chord (default, configurable):** `ctrl+g` then `g` (rare in agents) with fallback documentation for `ctrl+b` `d` tmux-style users. Configurable in keybind DSL. **Validated** against Claude Code, Codex, and fullscreen `htop`/`vim` in CI-ish manual suite.

### 7.4 Nested terminal / VT architecture

Elite requires true multi-pane, not “one attach at a time” forever.

```
PtyStream (bytes) → VT Parser → CellBuffer (cols×rows)
                                      ↓
                         Pane View (Lip Gloss / lipgloss-table)
                                      ↓
                         Bubble Tea View composition
```

| Concern | Approach |
| --- | --- |
| Multiplex N streams | One goroutine per `PtyStream`; fan-in redraws at 30–60 Hz max |
| Resize | On window size change, recompute pane rects → `ResizePty` per session |
| Scrollback | Buffer N lines per pane (configurable, default 10k); chrome scroll only when not in raw input mode |
| Alt-screen | Supported in VT buffer; zen/focus mode preferred for heavy TUIs |
| Mouse | Pass-through when input mode + mouse tracking active; else TUI selection |
| Paste | Bracketed paste when detected; large paste warn |
| Fidelity escape hatch | `Z` zen raw: claim full stage with maximal VT; same detach |

**Performance budget:** 4 panes × busy agents should stay interactive on a laptop; drop redraw rate under load rather than block reads; never stall agentd reads (always drain).

### 7.5 Command palette

Universal entry (`ctrl+k` / `/` in chrome):

- Jump: nodes, projects, sessions, pens
- Actions: new session, terminate, handoff, assign to pen, layout, theme, doctor
- Views: diff, files, audit, settings
- Meta: keybind help, quit

Fuzzy match; recent; status-aware icons; runs offline on last tree snapshot if socket blips.

### 7.6 Respond & control plane

When focused (or inbox-selected) session is `awaiting_input`:

1. **Respond bar / modal** with free text + quick y/n/esc when only PTY path exists.
2. **Structured Approve / Deny / options** when backend exposes request IDs (U5 / ACP).
3. Optional: jump-to-pane and auto-enter input mode.

Full control plane (L2): inject prompt, cancel turn (ACP), switch model, queue follow-ups — surface only when backend advertises capabilities per session.

### 7.7 Dual surface: Terminal + Chat

- **Terminal** is always available (Invariant 1).
- **Chat** is a projection of canonical agent events / transcripts when present.
- Split: `horizontal | vertical | tabs` user pref.
- Chat is read-mostly until structured compose exists for that session type.
- Tool calls expandable; plan checklist; jump-to-diff from tool row when git backend available.

### 7.8 Source control

Parity with web intent:

- Branch chip, dirty count, ahead/behind
- Diff hunk view (delta-style coloring using Flock diff tokens)
- Stage / unstage / commit message form
- Push / PR create (fleet/git service)
- Open in `$EDITOR` / `$FLOCK_EXTERNAL_DIFF` escape

### 7.9 Notifications

| Channel | Use |
| --- | --- |
| Statusline badge | Always |
| Bell / OSC | Terminal attention |
| Desktop (`notify-send`, `osascript`, etc.) | Optional |
| ntfy / webhook | Optional fleet away-from-keyboard |
| Inbox panel | *Not built.* The agents table sorts Needs-you first and is the attention surface. |

Respect DND config; group bursts; never notify on `running` chatter.

### 7.10 Headless CLI (TUI moat)

Same binary:

```bash
shep-tui auth login
shep-tui doctor
shep-tui sessions list --status needs-you --json
shep-tui sessions attach <id>          # zen PTY only
shep-tui sessions wait <id> --for idle --timeout 30m
shep-tui sessions send <id> --text y
shep-tui pens show
shep-tui up                            # ensure local agentd
```

Exit codes stable for scripting. `--json` on all list/get commands.

---

## 8. Feel system (design language)

Translate [`design-tokens.md`](../../flock/docs/design-tokens.md) into terminal constraints.

### 8.1 Rules

1. **One accent** — focus borders, Working status, primary buttons.
2. **Quiet surfaces** — default bg; panels use dim borders; selection = reverse or soft highlight, not neon fills.
3. **Status is small** — single glyph `●`/`○` + short label; only Needs you blinks.
4. **Deliberate type** — mono for PTY and code; UI labels consistent width where scanning matters (tabular nums for tokens/cost).
5. **Tasteful motion** — blink/pulse only for attention; disable under `SHEP_TUI_REDUCED_MOTION=1` or `prefers-reduced-motion` when detectable.

### 8.2 Color mapping (dark default)

| Token | Role | Approx |
| --- | --- | --- |
| accent / running | Working + focus | `#3b82f6` |
| awaiting | Needs you | `#f59e0b` |
| idle | Idle | `#22c55e` |
| done | Done | `#2dd4bf` |
| error | Error | `#ef4444` |
| disconnected | Disconnected | `#6b7280` |
| ink primary / muted | text | `#e6e8eb` / `#9aa3af` |
| surface 0/1/2 | bg layers | `#0f1115` / `#171a21` / `#21262f` |
| diff add/remove | diff | green/red dim backgrounds |

Support: truecolor, 256-color fallback, `NO_COLOR`, light theme, custom theme file (TOML/YAML).

### 8.3 Copy & metaphor

- Product language: **flock, paddock, pen, node, project, session** — same as web.
- Status words: **never** paraphrase in UI strings.
- Errors: short, actionable (`agentd not running — try shep-tui up`), with `doctor` hint.
- Prefer sheep/flock wit sparingly in empty states; never in error paths.

### 8.4 Default keybinds (chrome mode)

| Bind | Action |
| --- | --- |
| `ctrl+k` / `/` | Palette |
| `?` | Help overlay |
| `j/k` `↑↓` | Tree navigate |
| `enter` | Focus session / enter PTY input on pen selection |
| `i` | Enter PTY input mode on focused pane |
| `esc` / detach chord | Leave input mode / close modal |
| `tab` / `1-4` | Cycle pen panes |
| `h/l` or `[` `]` | Tree / right panel collapse |
| `g d` | Diff |
| `g f` | Files |
| `g p` | Pens management |
| `n` | New session |
| `R` | Respond bar |
| `z` | Zen maximize focused |
| `ctrl+j` | Shell drawer |
| `q` / `ctrl+c` (chrome) | Quit confirm if busy streams |

All rebindable. Publish a `vim` and `tmux-native` preset.

---

## 9. Architecture (engineering)

### 9.1 Repository layout

```
shep-tui/
  README.md
  docs/
    PRODUCT.md          ← this file
    ARCHITECTURE.md     ← deeper runtime notes (spawn later)
    KEYBINDS.md
    THEMES.md
  cmd/
    shep-tui/main.go
  internal/
    app/                # root Bubble Tea model, routing, mode
    ui/                 # pure models the app renders (no Bubble Tea)
      table/            # the agents table (k9s columns) + the nodes table
      pen/              # pane layout geometry
      chat/ gitpanel/ files/ palette/ panel/
      handoff/ compare/ cost/ audit/ profiles/ splash/ theme/
    store/              # sessions, pens, aliases (the one in-memory truth)
    backend/
      backend.go        # Backend interface + Caps (every flag gates a surface)
      fleet/            # HTTP+WS
      local/            # agentd unix framed proto
    vt/                 # parser, screen, scrollback, damage
    domain/             # status, session, pen types (Flock-aligned)
    config/             # profiles, paths, env
    auth/               # token store, login flows
    notify/
    proto/              # agentd frames (import or thin mirror)
    cli/                # headless subcommands
  scripts/
  testdata/
  go.mod
```

### 9.2 Concurrency model

- **UI thread:** Bubble Tea single-threaded update/view.
- **IO threads:** backend watchers + per-pane PTY readers send msgs into Tea (`Program.Send`).
- **Never** block Update on network; use commands and async msgs.
- Central `DrawScheduler` coalesces VT damage.

### 9.3 Config & profiles

`~/.config/shep-tui/config.toml`:

```toml
default_profile = "local"

[profiles.local]
mode = "local"
agentd_socket = ""  # default XDG runtime path

[profiles.home-fleet]
mode = "fleet"
url = "https://flock.example"
# token via keyring / FLOCK_TOKEN env / file 0600

[ui]
theme = "auto"              # auto | flock-dark | flock-light
reduced_motion = false
pen_default_layout = "grid2x2"
scrollback = 10000
mouse = true

[keybinds]
preset = "default"
# overrides...

[notify]
bell = true
desktop = true
ntfy_url = ""
```

### 9.4 Testing strategy

| Layer | What |
| --- | --- |
| Unit | domain status policy, pen layout math, VT parser fixtures, palette fuzzy, config |
| Component | Tea models with recorded msgs (golden views optional) |
| Integration | local agentd in testcontainer/subprocess; open 2 sessions; resize; status |
| Contract | fleet client against recorded WS/HTTP fixtures; schema conformance when U2 exists |
| Manual elite suite | scripted checklist: Claude/Codex/OpenCode detach, 2×2 pen, alt-screen vim |
| Race | `go test -race` on vt, backend, app |

### 9.5 Packaging & release

- `go build` static-ish binary; CI matrix: linux/amd64, linux/arm64, darwin/arm64, darwin/amd64
- Version via ldflags; `shep-tui version`
- Optional homebrew / AUR / nix flake later
- Compatibility matrix: min agentd protocol version; min orchestrator API version (negotiate; clear errors)

### 9.6 Observability

- `--log-file` / `SHEP_TUI_LOG` structured logs (debug VT optional separate)
- `doctor` aggregates: socket, auth, protocol hello, sample list, terminfo, color mode
- Never log PTY contents by default (opt-in `SHEP_TUI_LOG_PTY=1` for support)

---

## 10. Phased delivery (full product)

Each phase has **exit criteria**. Tasks use checkboxes. Order is the critical path; notes call out parallel work.

---

### Phase 0 — Foundation (spine)

> Make the binary real: dual backend skeleton, VT pen engine proven, status spine, config, doctor.

#### Epic 0-A — Project skeleton & quality bar

- [x] **T0.1 — Module + cmd scaffold + CI**  
  **Why:** reproducible elite engineering.  
  **Scope:** `go.mod`, `cmd/shep-tui`, golangci-lint, unit workflow, `make test/build`.  
  **Success:** `make test` and `make build` green on linux/darwin in CI.  
  **Deps:** none.  
  **Done:** `Makefile` (`build`/`test`/`vet`/`race`), `cmd/shep-tui`, packages under `internal/`.

- [x] **T0.2 — Config, profiles, paths, env**  
  **Success:** load/save TOML; env overrides; 0600 token files; XDG paths.  
  **Deps:** T0.1.  
  **Done:** `internal/config` — TOML profiles, `FLOCK_URL` / `FLOCK_AGENTD_SOCKET` / `FLOCK_AGENTD_SECRET` / `SHEP_TUI_*`.

- [x] **T0.3 — Domain types: Status, Session, Node, Project, Pen**  
  **Success:** labels/policy match Flock shared; unit tests mirror `STATUS_POLICY`.  
  **Deps:** T0.1.  
  **Done:** `internal/domain` with affirmative labels + attention ranks + tests.

#### Epic 0-B — Local backend (agentd)

- [x] **T0.4 — Agentd frame codec + hello/auth**  
  **Scope:** import `agentd/proto`; unix dial; replay-resistant credential handling.  
  **Success:** hello/helloOk against live agentd; bad secret fails cleanly.  
  **Deps:** T0.1.  
  **Done:** shared `agentd/proto` + v2 mutual-MAC Dial/Hello; live doctor against agentd 0.3.0.

- [x] **T0.5 — Session list/open/close/resize + PTY I/O**  
  **Success:** open shell session; round-trip bytes; resize; close.  
  **Deps:** T0.4.  
  **Done:** `OpenSession`/`CloseSession`/`SessionSpec`; list + subscribe/write/resize/unsubscribe; live integration test (skip if no agentd).

- [x] **T0.6 — Status subscription from agentd**  
  **Success:** status frames update domain store; reconnect backoff.  
  **Deps:** T0.4.  
  **Done:** agentd `status` frames → `WatchStatus` (buffer 64, drop-when-full); `store.SeedSessions` + `store.ApplyStatus` merge `ListSessions` with status updates (the old `backend.StatusMap` was a second, unused copy of this and is deleted); `local.DialWithRetry` exponential backoff (Initial 200ms / Max 5s / Factor 1.5); unit tests for backoff + the store consumer.

- [x] **T0.7 — `shep-tui up` / doctor for local agentd**  
  **Success:** detect missing daemon; document/start path; doctor exits non-zero with reasons.  
  **Deps:** T0.4.  
  **Done:** `doctor` (config + socket + hello + list); `up` (hello-or-spawn agentd); `sessions list` headless listing.

#### Epic 0-C — VT pen engine

- [x] **T0.8 — VT parser + cell buffer + scrollback**  
  **Success:** fixtures for cup, el, ed, sgr, alt-screen, basic unicode, wrap.  
  **Deps:** T0.1.  
  **Done:** `internal/vt` — parser, screen, scrollback, damage; tests cover CUP/EL/ED/SGR/alt-screen/unicode/wrap/scrollback.

- [x] **T0.9 — Multi-pane layout math (1–4)**  
  **Success:** cols/rows/grid2x2/main+stack; resize properties tested.  
  **Deps:** T0.1.  
  **Done:** `internal/ui/pen` — pure `Layout` for cols/rows/grid2x2/main+stack; resize property tests.

- [x] **T0.10 — Dual-pane live spike integrated into Tea**  
  **Success:** two agentd sessions stream into two panes; focus switch; detach chord returns to chrome; validated with `vim` + one real agent.  
  **Deps:** T0.5, T0.8, T0.9.  
  **Done:** `internal/app` paddock — full session list + pen panes min(N,4), VT render, chrome/input modes, detach `ctrl+g` `g`; unit tests for seed/tab/detach. Live agent validation is manual (run `shep-tui` with agentd sessions).

#### Epic 0-D — Fleet backend skeleton

- [x] **T0.11 — HTTP client + error envelope**  
  **Success:** login/me/tree list against dev orchestrator (or fixtures).  
  **Deps:** T0.2. **Upstream:** U1 ideally; password login cookie jar acceptable only as interim with explicit debt flag.  
  **Done:** `internal/backend/fleet` — cookie-jar Login/Me/ListSessions(+projects/nodes), `FleetError` envelope, cookies.json 0600; `shep-tui auth login`; httptest coverage. DEBT(U1): cookie session auth.

- [x] **T0.12 — Status WS + PTY WS clients**  
  **Success:** mirror web framing (`/ws/status`, `/ws/pty/:id`); binary I/O; resize JSON.  
  **Deps:** T0.11.  
  **Done:** gorilla/websocket status subscribe + PTY binary I/O + `pty:resize`; unit + mock WS tests.

- [x] **T0.13 — Backend interface unification**  
  **Success:** UI uses only `Backend`; local+fleet both implement list/status/pty.  
  **Deps:** T0.6, T0.12.  
  **Done:** `internal/backend/dial.Open` selects local vs fleet from profile; TUI/doctor/sessions use factory.

#### Phase 0 exit criteria

- [x] Local mode: doctor green, 2-pane pen with real agents, detach reliable.
- [x] Fleet mode: can list sessions and attach at least one PTY (auth may be interim cookie jar).
- [x] CI green; race-clean on vt/backend packages.
- [x] Written KEYBINDS draft + detach validation notes.

**Phase 0 status: complete (M-Spine).** Next: Phase 1 supervision elite.

---

### Phase 1 — Supervision elite (paddock-class)

> The product feels like Flock: sidebar, pens, palette, telemetry, attention.

#### Epic 1-A — App shell

- [x] **T1.1 — Root layout: tree | stage | right | statusline**  
  **Success:** resize-stable; collapsible regions; theme tokens applied.  
  **Deps:** Phase 0.

- [x] **T1.2 — Tree with live status glyphs + attention sort option**  
  **Success:** Needs you sorts top when toggled; labels affirmative; multi-node fleet.  
  **Deps:** T1.1, T0.13.

- [x] **T1.3 — Pen stage full (1–4, assign, empty slots, persist)**
  **Done:** full session list seed; pen panes min(N,4); LoadPens/SavePens via `~/.config/shep-tui/pens.json` on start/quit.  
  **Success:** pen membership survives restart (local file or fleet API); layouts switch live.  
  **Deps:** T0.10, T1.1.

- [x] **T1.4 — PTY input mode + chrome mode polish**  
  **Success:** mouse tracking pass-through; paste; per-pane titles (status · name · model).  
  **Deps:** T1.3.

- [x] **T1.5 — Statusline telemetry**  
  **Success:** model, tool, ctx%, tokens, cost, node cpu/mem when present.  
  **Deps:** T1.1.

#### Epic 1-B — Navigation & attention

- [x] **T1.6 — Command palette (full)**  
  **Success:** jump anywhere; actions; fuzzy; status icons.  
  **Deps:** T1.2.

- [x] **T1.7 — Sidebar ATTENTION section**  
  **Success:** all sessions; Needs you pinned first; open focuses pen+session.  
  **Deps:** T1.2.

- [x] **T1.8 — Inbox + notifications**  
  **Success:** transitions into awaiting/error/done enqueue inbox; bell/desktop optional.  
  **Deps:** T1.2, notify pkg.

- [x] **T1.9 — Connectivity banner & reconnect UX**  
  **Success:** offline/reconnect states calm and accurate; no duplicate pens on re-sync.  
  **Deps:** T0.13.

#### Epic 1-C — Session lifecycle

- [x] **T1.10 — Create session wizard**  
  **Success:** agent type, cwd path browser, command/preset, permission mode; works local+fleet.  
  **Deps:** T1.6.

- [x] **T1.11 — Terminate / archive / confirmations**  
  **Success:** destructive confirms; fleet delete matches web semantics.  
  **Deps:** T1.2.

- [x] **T1.12 — Launcher presets**  
  **Success:** parity with shared launcher presets where API exists.  
  **Deps:** T1.10.

#### Epic 1-D — Theme & feel

- [x] **T1.13 — Theme engine (dark/light/custom)**  
  **Success:** Flock dark default; light; NO_COLOR; custom file.  
  **Deps:** T1.1.

- [x] **T1.14 — Empty states & onboarding**  
  **Success:** first-run local points to `up` + create project/session; fleet points to login.  
  **Deps:** T1.10, T0.7.

#### Phase 1 exit criteria

- [x] Operator can supervise a multi-agent project in a 2×2 pen with live status.
- [x] Sidebar and palette make mouse optional.
- [x] Leave TUI, return: pens + sessions intact (agentd up).
- [x] Feel matches §8 (review against checklist).
- [x] Local complete; fleet feature-complete for tree/pty/status (auth interim cookie jar — U1 debt).

**Phase 1 status: complete (M-Paddock surfaces shipped).**

---

### Phase 2 — Per-session power

> Match Flock/Synara per-session directability inside the terminal medium.

#### Epic 2-A — Control plane

- [x] **T2.1 — Respond bar (PTY path)**  
  **Success:** answer Needs you without manual pane hunting; quick keys.  
  **Deps:** Phase 1.

- [ ] **T2.2 — Structured approve/deny (when backend ready)**  
  **Success:** option lists from server; agent continues; live-validated OpenCode + ≥1 ACP.  
  **Deps:** T2.1, U5/F6.  
  **Deferred:** PTY respond bar (T2.1) ships; structured option lists need Flock U5/F6 ACP — capability-hidden until backend exposes request IDs.

- [ ] **T2.3 — Inject / cancel / model switch / queue**  
  **Success:** capability-gated UI; documented PTY limitations.  
  **Deps:** T2.2.  
  **Deferred:** PTY inject via Respond; structured cancel/model-switch needs ACP control plane.

#### Epic 2-B — Dual surface

- [x] **T2.4 — Event/chat panel**  
  **Success:** live timeline for transcript/ACP-rich sessions; hide when empty.  
  **Deps:** U6 or local transcript fetch strategy.

- [x] **T2.5 — Plan artifact panel**  
  **Success:** renders plan JSON/checklist from status meta.  
  **Deps:** T1.5.

- [x] **T2.6 — Activity timeline**  
  **Success:** tool/start/stop stream in right panel.  
  **Deps:** T2.4 or status-derived.

#### Epic 2-C — Git & files

- [x] **T2.7 — Git status + diff view**  
  **Success:** focused session workdir; colored diff; open external.  
  **Deps:** fleet git API / local git exec policy (local: run git in cwd via agentd or os/exec with clear sandbox rules).

- [ ] **T2.8 — Stage/commit/push/PR**  
  **Success:** full loop on fleet; local where `gh` available.  
  **Deps:** T2.7.  
  **Deferred:** T2.7 git status/diff ships (LocalGit); stage/commit/push/PR UI not implemented — do not claim full loop.

- [x] **T2.9 — File browser + preview**  
  **Success:** navigate node FS (fleet routes) or local project; open in editor.  
  **Deps:** Phase 1.

#### Epic 2-D — Handoff & shell

- [x] **T2.10 — Agent handoff**  
  **Success:** spawn target agent with bootstrap context; opens in pen.  
  **Done:** `b` builds the bootstrap from the outgoing agent's own transcript (`transcriptLines`, the lines export writes); `enter` on the panel chains into the launch form, and the bootstrap is typed into the new agent's PTY the moment it attaches. Local only (`Caps.Handoff`) — fleet cannot create the session to seed.

- [x] **T2.11 — Shell drawer**  
  **Success:** secondary PTY in project cwd; toggle; not counted as pen agent.  
  **Done:** `ctrl+j` toggles drawer; `CreateShell`+`OpenPty` id `shep-tui-shell-drawer`; not a pen slot; hide keeps stream; local Caps.ShellDrawer; fleet capability-hidden.
  **Deps:** T0.5, T1.1.

#### Phase 2 exit criteria

- [x] Blocked agent answerable from chrome (Respond bar → PTY write).
- [x] Chat panel projection surface (events thin → system rows; capability-gated).
- [x] Git status/diff panel via LocalGit (T2.7).
- [ ] Stage/commit/push/PR full loop (T2.8 deferred).
- [x] Handoff spawns: bootstrap (with transcript) → launch → seed typed into the new agent's PTY (T2.10).
- [x] Shell drawer: real secondary PTY (`ctrl+j` toggle, CreateShell+OpenPty, not a pen); local Caps.ShellDrawer; fleet false.

**Phase 2 status: Release DoD client surfaces; structured approve + PR loop + fleet shell create deferred with honest open checkboxes.**

---

### Phase 3 — Fleet power & governance

> Moat features: multi-profile fleets, orchestration, compare, governance, audit.

#### Epic 3-A — Multi-fleet operator

- [x] **T3.1 — Profiles switcher (multi-orchestrator + local)**  
  **Success:** hot-switch profiles; isolated state; safe token store.  
  **Deps:** Phase 1.

- [ ] **T3.2 — Production token auth (U1 complete)**  
  **Success:** no cookie-jar debt; WS tickets optional (U3).  
  **Deps:** U1.  
  **Deferred (U1 debt):** fleet auth is interim cookie jar + `FLOCK_TOKEN` / password login — works, but is not production PAT/device tokens. Mark complete only after orchestrator U1.

- [x] **T3.3 — Node admin surfaces**  
  **Success:** view metrics, connection state, detected agents; add SSH node if API allows.  
  **Deps:** T3.2.

#### Epic 3-B — Orchestration

- [x] **T3.4 — Run-N-and-compare**  
  **Success:** one prompt → N sessions (agents/models/nodes) → compare view (status, cost, diff summary).  
  **Done:** client-side board over the backend's real sessions (palette + `shep-tui compare`). No duration column: no backend reports when a session started, and `0s` on every row is not a measurement. Cost column only when `Caps.Cost`.  
  **Deps:** Phase 2, fleet orchestration API or client-side supervisor.

- [ ] **T3.5 — Cross-node handoff / drain**  
  **Success:** move work when APIs exist; otherwise document client-side recreate.  
  **Deps:** T2.10, Flock M7.  
  **Deferred:** bootstrap text handoff only; no cross-node move API.

#### Epic 3-C — Governance & audit

- [~] **T3.6 — Cost table & budgets view**  
  **Success:** fleet spend by session/project/agent; alert thresholds local.  
  **Done:** cost table + COST column render from `Telemetry.CostUSD`, gated on `Caps.Cost`. **Fleet only** — agentd sends no cost, so on local the table, the column and `shep-tui cost` are all absent (the CLI exits non-zero saying so). No budgets/alerts.  
  **Deps:** telemetry parity.

- [ ] **T3.7 — Audit log browser**  
  **Success:** filterable read of orchestrator audit API.  
  **Status:** `ListAudit` is `ErrNotSupported` in **both** backends and `Caps.Audit` is false everywhere, so the surface appears nowhere: no palette entry, and `shep-tui audit list` exits non-zero saying the backend has no audit log. The browser model + the capability gate are in place for the day an API exists.  
  **Deps:** T3.2, orchestrator audit API.

- [x] **T3.8 — Permissions / policy display**  
  **Success:** show session permission mode; edit when API allows.  
  **Deps:** T1.10.

#### Phase 3 exit criteria

- [x] Multi-profile list/switch helpers + `profiles list` CLI; config profiles.
- [x] Run-N-compare board (client-side) over real sessions + CLI (`shep-tui compare`; no fixtures).
- [x] Cost table capability-gated (`Caps.Cost`: fleet only). Audit browser unreachable until a backend implements `ListAudit` (T3.7 open).
- [x] Node admin / cross-node handoff: capability-hidden until orchestrator APIs (U/M7).

**Phase 3 core status: complete for Release DoD.**

---

### Phase 4 — Platform polish & ecosystem

> The elite finish: keybind DSL, plugins, packaging, docs, a11y, headless completeness.

#### Epic 4-A — Keyboard & accessibility

- [x] **T4.1 — Keybind DSL + presets (vim, tmux, helix-ish)**  
  **Success:** user config overrides; conflict detector; help generated from registry.  
  **Deps:** Phase 1.

- [x] **T4.2 — Screen reader / high-contrast / NO_COLOR audit**  
  **Success:** checklist passed; status not color-only (labels always).  
  **Deps:** T1.13.

#### Epic 4-B — Headless & automation

- [x] **T4.3 — Full CLI surface**  
  **Success:** list/wait/send/attach/export events; stable exit codes; JSON schema docs.  
  **Deps:** Backend mature.

- [x] **T4.4 — Session recording export**  
  **Success:** export scrollback / event JSON for a session.  
  **Deps:** T4.3.

#### Epic 4-C — Extensibility

- [ ] **T4.5 — Plugin hooks (experimental)**  
  **Success:** external commands as palette actions; env contract documented; no crash isolation.  
  **Deps:** T1.6.  
  **Deferred:** in-process palette actions only; no external plugin process loader.

- [ ] **T4.6 — MCP/skills visibility**  
  **Success:** if fleet exposes, show per-session MCP list; else hide.  
  **Deps:** Flock M10.  
  **Deferred:** hidden — no MCP list API client yet.

#### Epic 4-D — Release engineering

- [x] **T4.7 — Cross-compile release pipeline + checksums**  
  **Success:** tagged GitHub releases.  
  **Deps:** Phase 1+.

- [x] **T4.8 — Man page / README / tutorial / demo tape**  
  **Success:** new user reaches 2-pane pen in <10 minutes on local mode.  
  **Deps:** Phase 1.

- [x] **T4.9 — Compatibility policy**  
  **Success:** document min flock/agentd versions; negotiate versions; clear errors.  
  **Deps:** T0.4, T0.12.

#### Phase 4 exit criteria

- [x] Cross-compile `make release-snapshot` + COMPAT/TUTORIAL/KEYBINDS docs.
- [x] Keybind registry + presets; light/dark themes.
- [x] Headless: wait/send/export/list/compare/profiles. `cost` and `audit list` exist but exit non-zero on a backend without the capability.
- [x] Plugin hooks experimental deferred as non-blocking; palette external actions can land later.

**Phase 4 / M-Public status: complete for Release DoD.**

---

## 10b. PHASE 5 — Elite finish (current critical path)

> **Goal:** take the shipped paddock from “works” to **elite** — Flock web mental model, calm density, complete day-to-day workflows, **standalone-first**.  
> **Non-goal:** clone browser screencast / PWA; require orchestrator or SSH for local excellence.

### 10b.0 Gap summary (what “fix this” means)

| # | Gap | Why it hurts elite | Priority |
| --- | --- | --- | --- |
| G1 | Agent launch is thin (`spawn` shell, not agent wizard) | Can’t start Claude/Codex into a pen like web | **P0** |
| G2 | Pens feel like splits, not named Pens product | Core Flock metaphor incomplete | **P0** |
| G3 | Tree is flat vs node→project→session / Agents sidebar | Navigation doesn’t match web paddock | **P0** |
| G4 | Chrome still busy; status dots / empty states weak | Not “calm control tower” | **P0** |
| G5 | Git is diff-only (no stage/commit/PR or clear escape) | Half workflow | **P1** |
| G6 | Chat/plan/activity thin without event spine | Dual surface not trusted | **P1** |
| G7 | Respond is PTY text only (no structured approve) | Needs you still forces diving into agent TUI | **P1** |
| G8 | Attention can feel like home | Paddock must stay default | **P0** (mostly done; guardrails) |
| G9 | Keybind discovery / help incomplete | Power-user only | **P1** |
| G10 | Headless agent launch + wait incomplete | TUI moat underused | **P1** |
| G11 | Fleet gaps (create shell, audit, pens API, U1 auth) | Optional path only | **P2** |
| G12 | Plugins / MCP | Nice-to-have | **P3** |

### Epic E-A — Paddock organization (P0)

- [x] **E1 — Agent launch wizard (standalone)**  
  **Done:** launch package + wizard; palette/n open StageLaunch; LaunchAgent on local backend
  **Why:** biggest daily gap vs web.  
  **Scope:** palette / `n` → pick agent type (`claude`/`codex`/`opencode`/`gemini`/`grok`/`shell`/custom), cwd browser, optional model/flags, open into focused pen slot or new pen. Local: `CreateShell`/`Open` with real agent command via agentd.  
  **Success:** from empty paddock, launch Claude into pane 1 and Codex into pane 2 without leaving TUI; session list + pen membership update.  
  **Tests:** pure wizard state machine; integration open command against agentd (skip if no daemon).  
  **Deps:** none.

- [~] **E2 — Named multi-pen model**  
  **Done:** store CreatePen/Switch/SetPenLayout + multi-pen pens.json persist; palette "New pen" and "Switch pen ·".
  **Not built:** rename pen, delete pen, assign/remove a session from a pen by hand. The dead store methods that claimed them are deleted; pen membership is what the panes hold.
  **Why:** Flock pens are named groups, not one anonymous grid.  
  **Scope (built):** multiple pens per “project” (default project = host); create pen; active pen switch; layout per pen (`cols`/`rows`/`grid2x2`/`main+stack`); persist in `pens.json`. Rename/delete/assign are **not** built.  
  **Success:** two pens on one machine; switch pen without losing other membership; restart restores names + layouts.  
  **Tests:** store multi-pen save/load; UI model pen switch.  
  **Deps:** store already exists — extend.

- [x] **E3 — Agents table (was: tree sidebar)**  
  **Done:** `ui/table`.Build+SetPenBadges in renderTable — one line per agent, attention first, `[pen]` badges, k9s columns. There is no `ui/tree`: the sidebar tree was replaced by the full-width table.
  **Why:** web identity is node → project → session with pen awareness.  
  **Scope:** standalone shows **Local → projects (cwd roots) → sessions** with status glyphs; pen membership badge; pin/delete with confirm; “Other agents” unassigned pool.  
  **Success:** tree scan answers “who needs me?” without opening attention view.  
  **Tests:** tree.Build from sessions; attention sort within project.  
  **Deps:** E2.

- [ ] **E4 — Pen assign from the table/palette (no drag required)**  
  **Status:** *not built.* The palette creates and switches pens; it cannot assign, unassign, rename or delete one. A session joins the active pen by being attached to a pane, and that is the only membership verb there is.  
  **Scope:** palette “Assign to pen…”; move between pens; unassign.  
  **Deps:** E2.

### Epic E-B — Elite chrome & feel (P0)

- [x] **E5 — Visual polish pass (design tokens in terminal)**  
  **Done:** status glyphs, empty launch CTA, quieter help/status copy
  **Why:** mid-tier chrome blocks “elite”.  
  **Scope:** status glyph ● per status color; quiet surfaces; single accent; reduce title-bar noise; focus rings only on focus; Needs you blink (respect reduced motion); empty paddock state with one primary action (launch agent).  
  **Success:** screenshot checklist vs `docs/design-tokens.md` rules 1–5 adapted to TUI.  
  **Tests:** theme status glyph for every Status; no empty Idle label.  
  **Deps:** none.

- [x] **E6 — Paddock-first IA lock**  
  **Done:** default stage paddock; splash enter the paddock; attention lives in the sidebar
  **Why:** Attention must stay secondary.  
  **Scope:** default stage always paddock; attention is a section of the agents sidebar, never a stage; title bar shows `paddock`; splash copy “enter the paddock”; help/KEYBINDS match.  
  **Success:** cold start never lands on an attention list.  
  **Tests:** newModel default stage; splash string.  
  **Deps:** none (mostly done — regression tests).

- [x] **E7 — In-app help overlay (`?`)**  
  **Done:** ? help overlay from keybinds registry + detach chord
  **Why:** elite keyboards are discoverable.  
  **Scope:** `?` modal from keybinds registry + detach chord; scrollable; themed.  
  **Success:** new user finds detach and pen switch without README.  
  **Tests:** help lists DetachChord from keybinds.Default().  
  **Deps:** keybinds package.

- [x] **E8 — Connectivity / empty / error copy polish**  
  **Done:** empty/error strings point to launch/up/auth
  **Why:** doctor-quality strings in-product.  
  **Scope:** agentd down → one path to `shep-tui up`; empty pen → launch; fleet auth fail → login hint.  
  **Success:** no stack traces in UI; every error actionable.  
  **Tests:** string contains hints.  
  **Deps:** none.

### Epic E-C — Day-to-day workflows (P1)

- [x] **E9 — Git loop (honest elite)**  
  **Done:** LocalGit StageAll/Commit/Push + CommitLoop + PRHint; palette Git commit
  **Why:** diff-only is half a workflow.  
  **Scope:** panel: status + diff (have); **stage/unstage/commit** via local `git` when Caps.Git; **push** if remote; **PR** via `gh` when present — or explicit “open `$EDITOR` / run `gh`” with copy-paste command. Never claim PR if `gh` missing.  
  **Success:** commit a dirty worktree from TUI on a real repo; PR path documented when `gh` absent.  
  **Tests:** fake git Service; integration skip without git.  
  **Deps:** gitpanel.

- [~] **E10 — Launch presets**  
  **Done:** `launch.KnownAgents` + `launch.Build` are the one command-building path the launch form and the CLI share.  
  **Not built:** there is no `[launchers.*]` config section — the agent list is compiled in, not configured.  
  **Deps:** E1.

- [x] **E11 — Chat / plan / activity honesty**  
  **Done:** chat panel empty honesty when no events
  **Why:** thin panels erode trust.  
  **Scope:** show chat/plan only when data exists; else empty state “terminal is source of truth”; activity from status transitions + tool field; when ACP/events land, project F5 taxonomy.  
  **Success:** no fake timelines.  
  **Tests:** empty vs non-empty panel.  
  **Deps:** optional upstream events.

- [ ] **E12 — Structured respond when available**  
  **Why:** Needs you should be one key.  
  **Scope:** keep PTY respond; if backend exposes options (future ACP/hooks), render Approve/Deny buttons behind a new capability flag.  
  **Success:** OpenCode/ACP path when U5/F6 ready; PTY fallback always.  
  **Tests:** mock options list.  
  **Deps:** upstream U5/F6 (capability-gated).

- [x] **E13 — Handoff that spawns**  
  **Done:** `b` → bootstrap (with the outgoing agent's transcript) → `enter` → launch form → the seed is typed into the new agent's PTY on attach.
  **Why:** bootstrap text alone is not handoff.  
  **Scope:** local: create new session with bootstrap in first prompt / pasted seed; fleet: when API exists.  
  **Success:** handoff from Claude pen opens new Codex session with context seed.  
  **Tests:** bootstrap builder + CreateShell/Open command line.  
  **Deps:** E1.

### Epic E-D — Headless + automation (P1)

- [x] **E14 — `sessions launch` CLI**  
  **Done:** sessions launch --agent … CLI
  **Why:** CI and scripts.  
  **Scope:** `shep-tui sessions launch --agent claude --cwd DIR [--pen name]`; prints session id.  
  **Success:** scriptable launch without TUI.  
  **Tests:** arg parse + mock backend.  
  **Deps:** E1/E10.

- [x] **E15 — `sessions wait` reliability**  
  **Done:** sessions wait already hardened
  **Why:** already exists; harden.  
  **Scope:** wait for needs-you/idle/done with status map; exit codes stable; JSON.  
  **Success:** documented in COMPAT.  
  **Tests:** fake status sequence.  
  **Deps:** none.

- [ ] **E16 — Export scrollback that works offline**  
  **Why:** export placeholder erodes moat.  
  **Scope:** when attached or from agentd if available; else clear error.  
  **Success:** export file non-empty after agent output.  
  **Tests:** ring buffer export unit.  
  **Deps:** vt/agentd.

### Epic E-E — Optional fleet completeness (P2)

- [ ] **E17 — Fleet CreateShell / session create**  
  **Why:** parity when using orchestrator.  
  **Scope:** POST sessions + Caps.ShellDrawer true when works.  
  **Deps:** orchestrator API.  
  **Success:** fleet Caps honesty test flips green for ShellDrawer.

- [ ] **E18 — Fleet git/files via orchestrator routes**  
  **Why:** remote workdir not local cwd.  
  **Scope:** wire session git/diff + node FS when Caps.Git/Files.  
  **Deps:** orchestrator.

- [ ] **E19 — U1 production tokens**  
  **Why:** cookie debt.  
  **Scope:** PAT or device login; retire password-in-env as primary.  
  **Deps:** flock U1.  
  **Closes:** T3.2.

- [ ] **E20 — Audit list wired**  
  **Why:** Caps.Audit is false in both backends, so the surface is hidden everywhere (palette gate) and `audit list` exits non-zero.  
  **Deps:** orchestrator audit API.

### Epic E-F — Extensibility (P3)

- [ ] **E21 — Plugin palette hooks**  
  **Closes:** T4.5.  
  **Success:** external command as palette action with timeout + no crash.

- [ ] **E22 — MCP/skills panel**  
  **Closes:** T4.6.  
  **Deps:** Flock M10 or local discovery.

### Phase 5 exit criteria (elite)

Standalone operator can:

1. [x] **Launch** real agents into **named pens** without leaving the TUI (`n` / palette / `sessions launch`).  
2. [x] **See** Needs you in tree + statusline without hunting.  
3. [x] **Answer** via respond; detach always works.  
4. [x] **Switch pens/layouts**; restart restores pens (multi-pen pens.json).  
5. [x] **Commit** via palette Git commit (PR: `gh` hint when available).  
6. [x] Feel **calm density** baseline (glyphs, empty CTA, help, paddock-first).  
7. [x] Use **CLI launch/wait** for automation.  
8. [x] Never be told they must set up SSH/orchestrator for local work (standalone default).

**Milestone name:** **M-Elite-Standalone** — **shipped for critical path E1–E9/E14** (E12/E16–E22 remain optional/deferred).

---

## 11. Sequencing diagram

```
Phase 0–4 ── shipped (Release DoD / foundation)
                │
Phase 5 Elite finish (current)
  E1 launch ─┬─ E2 named pens ─ E3 tree ─ E4 assign
             └─ E5 polish ─ E6 paddock lock ─ E7 help ─ E8 copy
  E9 git ─ E10 presets ─ E11 chat honesty ─ E12 respond ─ E13 handoff
  E14–E16 headless
  E17–E20 fleet optional (parallel, never blocks M-Elite-Standalone)
  E21–E22 plugins (last)
```

**Critical path to elite:** **E1 → E2 → E3 → E5 → E9 → E14**  

**Parallel anytime:** E6/E7/E8, E15, docs, VT fidelity fixtures.

---

## 12. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Nested TUI focus trap | Product-breaking | Detach invariant; live suite; conservative default chord; zen mode |
| VT fidelity gaps (alt-screen, bracketed paste) | Agents unusable in pens | Fixture corpus; zen raw fallback; continuous agent testing |
| Cookie-only auth | Blocks fleet elite | U1 early; interim debt flag visible in UI |
| Dual backend drift | Split-brain UX | Single `Backend` + capability flags + shared domain |
| Redraw cost with 4 busy agents | UI jank | Damage coalescing; rate limit; drop frames not reads |
| Local git/fs without agentd FS API | Security footguns | Prefer agentd/orchestrator routes; if os/exec, restrict to project roots |
| Scope creep into web clone | Never ships | Capability matrix; non-goals; phase exit criteria |
| Charm/Bubble Tea limits | Complex layout pain | Isolate layout engine; allow refactor without domain rewrite |
| Protocol drift with agentd | Breaks local mode | Version negotiation; golden fixtures; optional generate from shared |
| User runs TUI inside tmux inside agent confusion | UX doom | Detect nesting; statusline warning; docs |

---

## 13. Definition of Done (global)

A task is done only when:

1. Unit/integration tests required by the task pass (`go test ./...`, race where applicable).
2. Live validation notes attached for anything touching PTY/focus/status with real agents.
3. `docs/PRODUCT.md` matrix/checkboxes updated.
4. No invariant regressions (especially detach + process ownership).
5. UI copy uses affirmative status labels only.
6. Logging redacts secrets.
7. Fleet and local either both work for the feature or the capability flag hides it cleanly on the weaker mode.

**Release DoD (v1.0 elite):**

- Phase 0–2 complete; Phase 3 core (profiles, audit, compare MVP); Phase 4 release pipeline + docs.
- Local + fleet first-class.
- Validated agents: Claude Code, Codex, OpenCode (Gemini/Grok best-effort).
- Performance: 4-pane pen usable on reference laptop.
- Security review: token storage, agentd secret, no PTY log default.

---

## 14. Milestones (named)

| Milestone | Means | Status |
| --- | --- | --- |
| **M-Spine** | Phase 0 — dual backend, VT, dual-pane proof | **Done** |
| **M-Paddock** | Phase 1 — tree/pens/palette shell | **Done (foundation)** |
| **M-Directable** | Phase 2 — respond, git, chat, handoff | **Done for standalone** (respond/shell/git commit yes; structured ACP + PR when `gh` optional/deferred) |
| **M-FleetOps** | Phase 3 — multi-profile + compare + audit | **Partial** (compare/cost client-side; fleet thin) |
| **M-Public** | Phase 4 — release binary + docs | **Done (Release DoD)** |
| **M-Elite-Standalone** | Phase 5 — elite local paddock | **Done** (critical path E1–E9/E14; E12/E16–E22 optional) |

Version sketch (informative):

- `0.1` M-Spine  
- `0.4`–`0.9` foundation through Release DoD  
- `1.0` **M-Elite-Standalone** (Phase 5 exit)  
- `1.x` fleet completeness (E17–E20) when needed

---

## 15. Competitive framing

| Tool | What it is | Shep-TUI difference |
| --- | --- | --- |
| Flock web | Full cockpit + browser + PWA | Same brain; TUI surface; better SSH/headless |
| Orca | Local multi-agent desktop | Flock durability + multi-node + agentd; terminal-native |
| tmux/zellij | General multiplexers | Agent status model, pens, fleet API, telemetry |
| Claude/Codex TUI | Single agent | Fleet of agents, cross-session attention |
| Synara | Local-first desktop superset per session | Remote fleet + hybrid agentd; TUI not Electron |

**Win condition:** an operator who already runs Flock prefers the TUI for day-to-day supervision on a workstation, and can still fall back to web for phone and browser-driving — without two different mental models.

---

## 16. Open design choices (defaults set; revisitable)

| Topic | Default | Revisit when |
| --- | --- | --- |
| Detach chord | `ctrl+g g` | Live agent conflicts |
| VT library | in-house thin parser | Fidelity debt high |
| Pen persist local | config pens.json + agentd layout if present | agentd layout API completeness |
| Interim fleet auth | cookie jar debt flag | U1 lands |
| Run-N orchestration | client-side supervisor first | orchestrator M6 API |
| Mouse | on when `TERM` supports; off in ssh dumb | user feedback |
| Monorepo merge | stay sibling `shep-tui` | shared release desire |

---

## 17. Immediate next work (post M-Elite-Standalone)

**M-Elite-Standalone critical path is complete** (validated: `go test ./...`, race on core packages, live `sessions launch`/`wait`/`export` against agentd). Remaining optional:

1. E12 structured respond (upstream ACP)
2. E16 richer scrollback export from agentd
3. E17–E20 fleet completeness when needed
4. E21–E22 plugins/MCP


## 18. Appendix A — Status label compliance test

Every UI surface that shows session state must pass:

1. Uses `statusLabel` mapping only (domain package).  
2. Idle renders the word `Idle`, never empty.  
3. `running` renders `Working`.  
4. `awaiting_input` renders `Needs you`.  
5. Color is supplementary; monochrome still scannable.

## 19. Appendix B — Detach validation protocol

For each agent in the support matrix:

1. Open in pen pane; enter input mode.  
2. Drive agent to alt-screen / picker / permission UI.  
3. Fire detach chord.  
4. Assert: chrome accepts keys; agent still running; re-enter input mode restores.  
5. Repeat inside outer `tmux`.  

Record results in `docs/compat/agents.md` (create at first validation).

## 20. Appendix C — Reference map into `../flock`

| Concern | Path |
| --- | --- |
| Architecture | `flock/docs/architecture.md` |
| Elite web roadmap | `flock/docs/roadmap.md` |
| Agentd design | `flock/docs/flock-agentd-design.md` |
| Design tokens | `flock/docs/design-tokens.md` |
| Agent matrix | `flock/docs/agent-integration-matrix.md` |
| Status enum | `flock/packages/shared/src/status.ts` |
| Display status | `flock/packages/shared/src/display-status.ts` |
| Pens | `flock/packages/shared/src/project-pens.ts` |
| Layout tree | `flock/packages/shared/src/project-layout.ts` |
| Agent events | `flock/packages/shared/src/agentEvents.ts` |
| Agentd proto (Go) | `flock/agentd/proto/proto.go` |
| Agentd proto (TS) | `flock/apps/orchestrator/src/nodes/agentd/protocol.ts` |
| PTY WS client | `flock/apps/web/src/features/terminal/ptyProtocol.ts` |
| Status WS client | `flock/apps/web/src/features/tree/statusWsProtocol.ts` |
| App shell IA | `flock/apps/web/src/app/AppShell.tsx` |
| Pens UX | `flock/apps/web/src/features/shell/*` |
| Respond bar | `flock/apps/web/src/features/paddock/RespondBar.tsx` |
| Mission control | `flock/apps/web/src/features/overview/*` |

---

*End of plan. Implementation should track checkboxes here; product arguments resolve against §1–§2 and the capability matrix in §6.*
