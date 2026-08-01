# Tutorial — local paddock (1–4 pens) in under 10 minutes

**Goal:** run two live panes against local `flock-agentd`, type into an agent PTY, detach safely.  
**Mode:** local (default profile).  
**Last updated:** 2026-07-11

---

## 1. Prerequisites

- Go toolchain (to build from source) **or** a `shep-tui` binary from `make release-snapshot` / releases
- `flock-agentd` on your `PATH` (from the Flock monorepo agentd package)
- A real TTY (terminal emulator; not a bare pipe)

```bash
# from shep-tui repo
make build
./bin/shep-tui version
./bin/shep-tui doctor   # expect local socket / agentd guidance
```

---

## 2. Start agentd

```bash
# ensure daemon is up (shep-tui can spawn it when binary is found)
./bin/shep-tui up
./bin/shep-tui doctor
```

Socket defaults (see `config.DefaultAgentdSocket`):

- `$FLOCK_AGENTD_SOCKET` if set  
- else `$XDG_RUNTIME_DIR/flock-agentd.sock`  
- else `/tmp/flock-agentd-<uid>.sock`

Secure prepared nodes use `FLOCK_AGENTD_NODE_ID` plus
`FLOCK_AGENTD_SECRET_FILE` or profile `agentd_node_id` + `agentd_secret_file`.
The default standalone development daemon uses `development-local` and an empty
credential while still completing the nonce/MAC handshake.

---

## 3. Spawn two shell sessions (optional)

With no sessions the paddock opens on its empty state (`press n to launch agent`).
Pass `--demo` to have it seed two throwaway shells instead, or prepare them
explicitly:

```bash
./bin/shep-tui sessions spawn pane-a
./bin/shep-tui sessions spawn pane-b
./bin/shep-tui sessions list
```

---

## 4. Launch the paddock TUI

```bash
./bin/shep-tui
# or
./bin/shep-tui tui
```

You should see **two panes** (up to the first two sessions), chrome mode footer:

`tab:focus  i/enter:input  1/2:pane  q:quit`

| Key | Action |
| --- | --- |
| `tab` | Focus next pane |
| `1` / `2` | Focus pane 1 or 2 |
| `i` or `enter` | Enter **input mode** (keys → agent PTY) |
| `q` | Quit TUI (agents keep running in agentd) |

---

## 5. Type into a pane, then detach

1. Focus a pane (`tab` or `1`/`2`).
2. Press `i` to enter input mode.
3. Type shell commands / drive a nested TUI as needed.
4. **Detach** without killing the session: press **`ctrl+g`** then **`g`**.

You are back in chrome mode; the agent continues in agentd.

> Detach is a product invariant. Do not rely on `ctrl+c` inside nested agents to leave the paddock — use the detach chord. See [`KEYBINDS.md`](KEYBINDS.md).

---

## 6. Headless companions

```bash
./bin/shep-tui sessions list
./bin/shep-tui sessions wait <id> --for idle --timeout 30s
./bin/shep-tui sessions send <id> --text $'y\n'
./bin/shep-tui sessions export <id>
./bin/shep-tui profiles list
./bin/shep-tui compare
```

---

## 7. Profiles (local ↔ fleet later)

Default profile is `local`. List:

```bash
./bin/shep-tui profiles list
```

Fleet quick-start (when you have an orchestrator):

```bash
export FLOCK_URL=https://your-orchestrator.example
export FLOCK_TOKEN=…          # or: shep-tui auth login
./bin/shep-tui doctor
./bin/shep-tui tui
```

Config lives under `~/.config/shep-tui/config.toml` (override with `SHEP_TUI_CONFIG_DIR`).

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| “requires a terminal” | Run in a real TTY, not CI pipe |
| Socket not found | `shep-tui up` / start agentd |
| Empty panes / spawn fails | `sessions list`, check agentd logs |
| Stuck in agent TUI | Detach: `ctrl+g` then `g` |
| Protocol / version errors | See [`COMPAT.md`](COMPAT.md) |

---

## Next reading

- [`KEYBINDS.md`](KEYBINDS.md) — full chrome/input binds  
- [`COMPAT.md`](COMPAT.md) — agentd & orchestrator versions  
- [`PRODUCT.md`](PRODUCT.md) — roadmap (pens, sidebar attention, fleet power)  
