# Shep-TUI keybinds (current)

**Runtime chrome (paddock):** [`internal/app/app.go`](../internal/app/app.go)  
**Registry + presets (Phase 4):** [`internal/keybinds`](../internal/keybinds/keybinds.go)  
**Product target binds (full paddock):** [`PRODUCT.md` §8.4](PRODUCT.md)  
**Last updated:** 2026-07-11

This document describes **what ships today** in the paddock TUI
(`shep-tui` / `shep-tui tui`). The `keybinds` package is the single source of
truth: the app derives its keymap and its chord engine from it, `?` help is
generated from it, and the chrome table below is generated from it — a test fails
on drift. **Detach remains `ctrl+g` then `g`.**

---

## Modes

| Mode | Meaning |
| --- | --- |
| **Chrome** | Host keys handled by shep-tui (focus, quit, enter input). Default on start. |
| **Input** | Keys go to the input target’s PTY (`PtyStream.Write`) — the focused pane, or the shell drawer when it holds the keyboard. Only the `ctrl+g` chords are intercepted. |

Detach always works (PRODUCT.md §2 invariant 4). Closing the TUI does **not** kill
agent sessions (they live in `flock-agentd`).

---

## Chrome mode

Generated from `keybinds.Default()` — do not hand-edit between the markers.

<!-- BEGIN GENERATED KEYBINDS -->
| Bind | Action |
| --- | --- |
| `ctrl+k` | command palette |
| `n` | launch agent |
| `?` | help |
| `q` / `ctrl+c` | quit |
| `i` | PTY input mode |
| `ctrl+g then g` | detach from agent PTY |
| `enter` | select / activate |
| `esc` | close overlay / back |
| `tab` | next pane |
| `shift+tab` | prev pane |
| `1` | focus pane 1 |
| `2` | focus pane 2 |
| `3` | focus pane 3 |
| `4` | focus pane 4 |
| `k` / `up` | up · pane above |
| `j` / `down` | down · pane below |
| `h` / `left` / `[` | pane left · prev region |
| `l` / `right` / `]` | pane right · next region |
| `pgup` / `ctrl+u` | scroll up |
| `pgdown` / `ctrl+d` | scroll down |
| `g then g` | scroll to top |
| `G` | scroll to bottom |
| `a` | session actions |
| `R` | respond bar |
| `r` | rename session |
| `x` | kill session |
| `z` | zen maximize pane |
| `p` | pens (multi-pane grid) |
| `N` | nodes (scope agents) |
| `/` | filter the table |
| `ctrl+j` / `ctrl+g then j` | shell drawer |
| `s` | focus shell drawer |
| `t` | retry attach |
| `ctrl+r` | reconnect backend |

<!-- END GENERATED KEYBINDS -->

`enter` on the agents table drills into the row under the cursor: that agent's
terminal fills the window, and `esc` comes back. In a terminal `enter` enters PTY
input mode, like `i`. Quitting closes local PTY streams; agents keep running in
agentd.

The agents table is one line per agent — the ones that need you first, then the
roster by name — so `j` / `k` walk it and `/` filters it live (`esc` clears).
`p` opens the pens grid (1–4 panes); `esc` leaves it. In a terminal the scroll
binds walk the focused pane's scrollback (`esc` or `G` returns to live output)
and drive the scroll of an open panel. A pane running a full-screen program (alt
screen) keeps no history, so scrolling it is a no-op.

Chords (`g g`, `ctrl+g g`) expire after 800 ms, so a stray prefix never eats the
next key.

`t` re-attaches the focused pane after an attach failed or its PTY closed; the
pane says so and names the key. `ctrl+r` re-dials the backend — the paddock
retries on its own with backoff when the status stream drops, and `ctrl+r` is how
you restart that after it has given up (`backend lost` banner).

Header hotkeys (chrome): the keys that work on the row under the cursor, drawn
permanently in the header in two columns — the selection's verbs first, then the
app's keys. There is no key strip at the bottom. What an agent is running is
drawn on that agent's row in the table.

`a` opens the actions for the selected session, listing only what can be done to
it right now; the same letters run those actions directly from the table, and the
header advertises exactly those.
A panel advertises its scroll keys, the palette its own — never a key the surface
does not dispatch. Full binds in `?` help. Ephemeral messages appear bottom-right
and expire on their own; errors are marked `✗` and stay longer.

### Command palette (`ctrl+k`)

Bottom-docked, grouped catalog:

| Group | Examples |
| --- | --- |
| **Navigate** | Agents table, Pens, Filter, Respond, Zen, Shell drawer, Focus pane 1–4, Region next/previous |
| **Agents** | Launch agent, Spawn shell, Handoff |
| **Pens** | New pen, Switch pen · …, Pen layout · cols/rows/2×2/main+stack |
| **Git** | Status/diff, Commit |
| **Inspect** | Chat, Files, Cost, Compare, Audit |
| **Settings** | Settings, Theme, Profile, Help, Quit |
| **Sessions** | Jump to session by name/status |

| Bind | Action |
| --- | --- |
| type | Fuzzy filter — prefix beats substring beats subsequence (`gc` → Git commit) |
| `↑` / `↓` | Move selection (`ctrl+p` / `ctrl+n`) |
| `tab` / `shift+tab` | Jump next/previous **group** |
| `enter` | Run selected command (a no-op while nothing matches) |
| `esc` | Close palette |

Every row that has a key shows it as a chip, rendered from the live keymap — rebind
an action and the chip follows.

Tip: type `set` / `theme` / `help` to reach Settings quickly.

### Mouse

Enabled by default; turn it off with `[ui] mouse = false` (or the Mouse row in
Settings) to give the terminal back its native text selection.

| Event | Action |
| --- | --- |
| click a pane | Focus it |
| click a table row | Select that agent |
| click the shell drawer | Focus it (`i` then types into it) |
| click a palette row | Run it |
| wheel over a pane | Scroll its scrollback (no-op on an alt-screen agent) |
| wheel over the table or a panel | Scroll it |

In **input mode the mouse belongs to the agent's program**, and shep-tui cannot
know whether that program enabled mouse tracking, so pointer events are swallowed
rather than forwarded as escape sequences. Detach to use the mouse on the chrome.

### Charm polish (Bubbles / Huh)

| Surface | Implementation |
| --- | --- |
| Palette filter | `bubbles/textinput` |
| Respond bar | `bubbles/textinput` |
| Launch wizard (`n`) | `huh` form (agent · cwd · confirm) |
| Help (`?`) | `bubbles/help` from keybind registry |
| Starting / reconnect | `bubbles/spinner` |
| Needs you | blink `●`/`○` (1s); disabled with `reduced_motion` / `SHEP_TUI_REDUCED_MOTION=1` |

The agents that need you lead the agents table (not an “inbox”); Needs you also pulses in the header count.

---

## Input mode

Every key except the `ctrl+g` chords is forwarded as terminal bytes to the input
target's PTY (arrows, enter, backspace, delete, insert, shift+tab, F1–F12,
modified arrows, alt-chords, ctrl letters, printable runes, etc.). A key with no
byte form is reported in the statusline rather than dropped in silence.

| Bind | Action |
| --- | --- |
| `ctrl+g` then `g` | **Detach** — return to chrome mode |
| `ctrl+g` then `j` | Show/hide the shell drawer, keeping the keyboard where it is |
| `ctrl+g` then `ctrl+g` | Send a literal BEL (`0x07`) |

**`ctrl+j` is not the drawer key here**: it is LF (`0x0a`), which agent CLIs and
readline bind, so input mode gives it to the agent. `ctrl+j` still toggles the
drawer in chrome mode, which is where the toggle belongs.

### Input target

`i` / `enter` hand the keyboard to the PTY of the **focused region**: the pane on
the stage, or the shell drawer from the shell region (`s`, or `tab` into it while
it is open). Showing or hiding the drawer never moves the keyboard by itself.
Keys typed at a drawer whose attach is still in flight are dropped with
`shell drawer attaching…` — they are never redirected to a pane.

### Detach chord details

1. Press `ctrl+g` — arm detach (title bar shows `input (ctrl+g … press g to detach)`).
2. Press `g` — leave input mode; focus stays on the same pane.
3. Any other key cancels the chord; the buffered `ctrl+g` (BEL, `0x07`) **and**
   the cancelling key are both forwarded to the PTY, so a literal `ctrl+g` is
   sendable. Waiting 800 ms cancels the chord and flushes the same way.

Chrome chords (`g g`) never arm in input mode — only detach and the drawer chord
are intercepted there.

**Why this chord:** rare in nested agent TUIs (vim, Claude Code, fullscreen tools).
Registry constant: `keybinds.ActionDetachChord` → `["ctrl+g","g"]` in `Default()`,
`Vim()`, and `Tmux()` (tmux also lists alt `ctrl+b` then `d` as `DetachTmux`).
Do not remove detach.

Footer help (input):  
`detach: ctrl+g then g  |  keys → agent PTY`

### Presets & overrides (registry)

The TUI loads `~/.config/shep-tui/keybinds.toml` (XDG-aware, alongside
`config.toml`) and merges it over the preset named in `config.toml`:

```toml
# config.toml
[keybinds]
preset = "default"   # default | vim | tmux
```

```toml
# keybinds.toml — every key here is optional
preset = "vim"                   # overrides config.toml's preset

[keybinds]
Quit = ["x"]                     # one sequence
Palette = [["ctrl+k"], ["/"]]    # alternates
DetachChord = ["ctrl+g", "g"]    # a chord
Zen = []                         # unbind
```

Action names are the `keybinds.Action` constants (`FocusNext`, `FocusPane1`…`4`,
`EnterInput`, `Activate`, `Esc`, `Quit`, `Palette`, `Launch`, `Respond`,
`Actions`, `Rename`, `Kill`, `Help`, `Zen`, `Pens`, `Nodes`, `ShellDrawer`, `TreeUp`, `TreeDown`, `RegionPrev`,
`RegionNext`, `ScrollUp`, `ScrollDown`, `ScrollTop`, `ScrollBottom`, `Retry`,
`Reconnect`, `DetachChord`, `DetachTmux`).

The file is validated on load: an unknown action name, an empty key, or the same
chord bound to two actions is reported on stderr and the file is **ignored** —
the TUI still starts on the preset. Unbinding `DetachChord` is restored: without
it there is no way out of a full-screen agent.

---

## Fatal / error screen

If config load, agentd dial, or session list fails before the paddock starts, a
centered error view is shown. **Any key** quits. Hint typically points at
`shep-tui doctor` / `shep-tui up`.

---

## Headless CLI (no TUI keybinds)

| Command | Notes |
| --- | --- |
| `shep-tui` / `shep-tui tui` | Interactive paddock TUI (1–4 pens; requires a TTY) |
| `shep-tui up` | Ensure local `flock-agentd` is running |
| `shep-tui doctor` | Config + connectivity health |
| `shep-tui sessions list` | List sessions |
| `shep-tui sessions wait <id> --for idle\|done\|needs-you` | Server-side wait when `agent_control_v1`; else poll |
| `shep-tui sessions explain <id>` | `statusExplain` (matched rule / why) |
| `shep-tui sessions prompt <id> --text …` | `session.prompt` (text+Enter) |
| `shep-tui sessions send <id> --text …` | Write raw bytes to PTY |
| `shep-tui sessions export <id>` | Scrollback or events placeholder |
| `shep-tui profiles list` | Config profiles |
| `shep-tui compare` | Compare board over the backend's sessions |
| `shep-tui audit list` | Audit log — no backend implements it yet (exits non-zero) |
| `shep-tui cost` | Session cost table — only where the backend reports cost (exits non-zero otherwise) |
| `shep-tui version` | Print build version |
| `shep-tui help` | Usage |

See also [`TUTORIAL.md`](TUTORIAL.md).

---

## Validation notes (detach)

Unit coverage in `internal/app`:

- Chrome `tab` cycles focus
- Detach chord `ctrl+g` → `g` returns to chrome
- `keyToBytes` maps common keys for PTY write

Manual: run two agentd sessions, `shep-tui`, focus with `tab`/`1`/`2`, `i` into
input, exercise nested `vim` or a real agent, detach with `ctrl+g` `g`.
