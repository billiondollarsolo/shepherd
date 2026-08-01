# shep-tui

Lives in the **shepherd** monorepo as `shep-tui/` (next to `agentd/`). Build with `make build` from this directory; `go.mod` replaces agentd via `../agentd`.

**Terminal paddock for CLI coding agents — standalone by default.**

Formerly **`flock-tui`** (Shepherd rename). Binary, module, config dir, and
`SHEP_TUI_*` env vars use the new name; `FLOCK_TUI_*` and `~/.config/flock-tui`
still work as a legacy fallback when the new config dir is absent.

Shepherd Claude Code, Codex, OpenCode, Gemini, Grok, … from a TTY with **pens**,
live status (**Idle / Working / Needs you**), and sessions that outlive the UI.

**No Flock web, orchestrator, or SSH required** for full local use — only
`flock-agentd` on this machine. Optional fleet mode talks to a Flock deploy later.

> **Product plan (incl. Phase 5 elite finish):** [`docs/PRODUCT.md`](docs/PRODUCT.md)  
> **Keybinds:** [`docs/KEYBINDS.md`](docs/KEYBINDS.md) · **Standalone vs multi-machine:** [`docs/NODES.md`](docs/NODES.md)

### Roadmap status

| Milestone | Meaning |
| --- | --- |
| Phases 0–4 | **Shipped** — durable paddock foundation (Release DoD) |
| **M-Elite-Standalone** | **Shipped** — launch wizard, named multi-pen, Agents tree, git commit, CLI launch (`PRODUCT.md` §10b; E12/E16–E22 optional) |

## Quick start (standalone)

```bash
make build
./bin/shep-tui up              # start local flock-agentd if needed
./bin/shep-tui doctor
./bin/shep-tui                 # splash → paddock (tree · pens 1–4)
```

Prepared secure nodes require the matching `FLOCK_AGENTD_NODE_ID` and
`FLOCK_AGENTD_SECRET_FILE`. Plain `FLOCK_AGENTD_SECRET` remains an ephemeral
development override and is never persisted.

## Requirements

- Go **1.25+** to build
- **Standalone:** `flock-agentd` (`./bin/shep-tui up` or `flock-agentd serve`)
- **Optional fleet:** Flock orchestrator URL + auth (`FLOCK_URL`)

## Build

```bash
make build          # → bin/shep-tui
make test
./bin/shep-tui version
./bin/shep-tui help
```

## Commands

```bash
shep-tui                 # interactive paddock (standalone local by default)
shep-tui up              # ensure local flock-agentd is running
shep-tui doctor          # health
shep-tui sessions list|spawn|launch|wait|send|export
shep-tui profiles list|use <name>
shep-tui compare           # board over the backend's real sessions
shep-tui cost              # fleet only: agentd reports no cost
```

Paddock flags: `--profile NAME`, `--config-dir DIR`, `--theme auto|flock-dark|flock-light`,
`--socket PATH`, `--scrollback N`, `--no-splash`.

Interactive TUI needs a TTY. Detach from PTY input: **`ctrl+g` then `g`**.

## Architecture

```
# Standalone (default) — full paddock on this machine
shep-tui  ──unix──▶  flock-agentd  ──PTY──▶  agents

# Optional fleet — multi-machine via Flock orchestrator
shep-tui  ──REST/WS──▶  orchestrator  ──▶  agentd on nodes (SSH-managed by orchestrator)
```

Sessions always live in **agentd** (viewer never owns processes).

### Packages

| Package | Role |
| --- | --- |
| `cmd/shep-tui` | Binary entry |
| `internal/cli` | Subcommands: `tui`, `up`, `doctor`, `sessions`, `version`, `help` |
| `internal/app` | Bubble Tea paddock (sidebar · pens 1–4 · palette), detach |
| `internal/backend` | `Backend` interface |
| `internal/backend/local` | agentd unix client (hello, sessions, PTY, status, reconnect) |
| `github.com/billiondollarsolo/flock/agentd/proto` | shared agentd framed control/data codec |
| `internal/vt` | VT parser, cell buffer, scrollback, damage |
| `internal/ui/pen` | Multi-pane layout math (1–4) |
| `internal/domain` | Status, Session, Node, Project, Pen types |
| `internal/config` | TOML profiles, env overrides, XDG paths |

## Config

Default path: `~/.config/shep-tui/config.toml`  
Override directory: `SHEP_TUI_CONFIG_DIR` (or `--config-dir`)

Precedence is **flag > env > config file > default** — one chain, everywhere.

```toml
default_profile = "local"

[profiles.local]
mode = "local"

[ui]
theme = "auto"              # auto | flock-dark | flock-light
reduced_motion = false
pen_default_layout = "grid2x2"   # cols | rows | grid2x2 | main+stack
scrollback = 10000
mouse = true

[keybinds]
preset = "default"          # default | vim | tmux (per-action rebinds: keybinds.toml)
```

Everything in `[ui]` is editable from inside the paddock (`ctrl+k` → *Settings…*) and
saved back to this file. A `default_profile` that names no configured profile is an
error, not a silent fall back to `local`.

Useful env:

| Env | Effect |
| --- | --- |
| `FLOCK_URL` | Force fleet mode against this orchestrator |
| `FLOCK_AGENTD_SOCKET` | Local agentd unix path |
| `FLOCK_AGENTD_NODE_ID` | Stable daemon identity |
| `FLOCK_AGENTD_SECRET_FILE` | Protected daemon credential file |
| `FLOCK_AGENTD_SECRET` | Ephemeral development credential override |
| `SHEP_TUI_PROFILE` | Active profile name |
| `SHEP_TUI_REDUCED_MOTION` | `1`/`0` — overrides `reduced_motion` |
| `NO_COLOR` | Render without color |

## Roadmap (short)

| Phase | Name |
| --- | --- |
| 0 | Foundation — dual backend, VT pen engine, doctor, paddock seed |
| 1 | Supervision elite — sidebar, pens, attention, palette |
| 2 | Per-session power — respond, chat, git, handoff |
| 3 | Fleet power — multi-profile, compare, audit |
| 4 | Platform polish — keybinds DSL, headless CLI, release |

Full task breakdown, capability matrix, and DoD: **`docs/PRODUCT.md`**.

## License

Same family as Flock (MIT) — LICENSE to be added at first public release.
