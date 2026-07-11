# flock-agentd — node daemon design

Status: **AS-BUILT (shipped).** This was a design doc; the daemon is now live and
is the sole PTY/persistence layer — **tmux has been removed entirely** (no
fallback). The wire contract lives in `apps/orchestrator/src/nodes/agentd/protocol.ts`
(TS) ⇄ `agentd/internal/proto/proto.go` (Go); the daemon version is single-sourced
in `agentd/VERSION`. The sections below are kept as the original design rationale;
where they say "will" / "decision to confirm", read them as decided + implemented.

---

## 1. Why

The node side of Flock is currently a patchwork bent around tools never meant for
it:

- **tmux** for PTY persistence + multiplexing → recurring xterm↔tmux↔WS friction:
  Device-Attributes reply leaks (`0;276;0c`), `window-size` policy fights,
  resize-to-client→resize-window indirection, per-attach probes, status-bar
  artifacts. These are structural, not one-offs.
- **reverse SSH tunnel** so agents can `curl` hook callbacks back.
- **per-command `transport.exec`** for the file browser, git, diff, path picker —
  one SSH round-trip per operation.
- **OSC/PTY scraping + reconcile** for status, spread across modules.

Each is a separate mechanism layered on raw SSH. A single node-side process that
owns all of it is simpler, faster, cleaner, and removes the entire class of
terminal-emulation bugs (raw PTYs, direct resize, no tmux).

Orca proves the clean-terminal model (raw `node-pty` per pane, no tmux) — but Orca
is a **local** app, so its PTYs live with the process and it needs no node-side
persistence. Flock is **remote + must survive disconnect** (close your phone, the
agent keeps running, reconnect later, layout intact). That persistence layer must
live on the node: today it's tmux; flock-agentd is us owning it deliberately.

## 2. Non-negotiable requirements

1. **Reached over the SSH connection we already own** — daemon listens on node
   **loopback only**; the orchestrator reaches it via an SSH `direct-tcpip`
   channel (or a unix socket for the local node). No new inbound port, no
   firewall changes; SSH provides authn + encryption. (We already run
   `SupervisedSshConnection` + a reverse tunnel — same machinery.)
2. **Survives orchestrator disconnect/restart** — daemon is long-lived; PTYs keep
   running; on reconnect the orchestrator re-attaches and gets scrollback replay.
3. **Survives node reboot / daemon crash** to tmux-parity: live PTY state is lost
   (no process survives its parent dying — tmux doesn't either without resurrect),
   BUT session metadata + layout are persisted to disk and restored; agent
   sessions can be **respawned** and the layout rebuilt.
4. **Server-authoritative layout** — the pane/split tree persists on the node, so
   "go away and come back" restores the exact terminal layout, not just the PTYs.
5. **Dumb-courier-friendly bootstrap** — a node still only needs SSH; the
   orchestrator **ships + launches + upgrades** the daemon over SSH automatically.
6. **The browser UI is unchanged** — the React Terminal / split pane-manager /
   fit hardening / layout / file browser are reused as-is. The daemon changes only
   what lives behind the existing `/ws/pty` (and later `/ws` data) endpoints.

## 3. Language / runtime

**Recommendation: Go.** A daemon's hardest cost is distribution + supervision, and
Go minimizes it: a single static ~5–10 MB binary, trivial cross-compile
(`linux/amd64`, `linux/arm64`, `darwin/arm64`, …), no runtime deps, first-class
concurrency for stream multiplexing, mature PTY (`github.com/creack/pty`) and
systemd integration. The cost is a second language + a protocol contract boundary
with the TS orchestrator.

Alternative: **Node** (matches the codebase, lets us share `@flock/shared` types)
— but `node-pty` is a native module needing per-arch prebuilds, and shipping a
Node runtime to every node is exactly the distribution pain we want to avoid
(SEA/pkg helps but is fiddly).

→ **DECISION TO CONFIRM.** Default to Go unless we value type-sharing over deploy
simplicity. The protocol contract is defined once (see §6) and mirrored on both
sides regardless.

## 4. Topology

```
 orchestrator (host)                         node (local or remote)
 ┌───────────────────┐    SSH direct-tcpip   ┌──────────────────────────┐
 │ NodeAgentClient   │◀────────────────────▶ │ flock-agentd (loopback)  │
 │  (per node)       │   (or unix socket)    │  ├─ session: agent (PTY)  │
 │  ▲                │                       │  ├─ session: shell-1 (PTY)│
 │  │ bridges to     │                       │  ├─ session: shell-2 (PTY)│
 │  │ /ws/pty (web)  │                       │  ├─ layout store (disk)   │
 └──┼────────────────┘                       │  ├─ scrollback rings      │
    │                                        │  └─ (v2) fs/git/hooks     │
 browser xterm/splits                        └──────────────────────────┘
```

- **Remote node:** orchestrator opens an SSH `direct-tcpip` channel to
  `127.0.0.1:<agentd-port>` over the existing `SupervisedSshConnection`
  (ssh2 `forwardOut`). One channel per node; sessions are multiplexed with
  tagged frames.
- **Local node:** connect to a unix socket (`$XDG_RUNTIME_DIR/flock-agentd.sock`)
  — no SSH.
- The browser still talks to the orchestrator's `/ws/pty/:id`; the orchestrator's
  `NodeAgentClient` bridges those bytes to/from the daemon session. The web side
  doesn't know the daemon exists.

## 5. Bootstrap, supervision, upgrade (the hard part — addressed up front)

- **Probe:** on node connect, orchestrator opens the loopback channel; if it
  fails → daemon not running.
- **Install:** push the arch-matched binary over SSH (`sftp`/`cat > ~/.flock/bin/
flock-agentd-<ver>`), `chmod +x`. The orchestrator carries binaries for each
  supported `os/arch` (built in CI).
- **Launch + supervise:** prefer `systemd --user` (with `loginctl enable-linger`
  so it survives logout/reboot) → `Restart=always`. Fallback: `launchd` (macOS),
  else `nohup … & disown` + a re-bootstrap on next connect. The unit runs
  `flock-agentd serve`.
  - **T26 — nohup reboot caveat (operational):** the `nohup` fallback does NOT
    survive a node reboot, and recovery is **lazy, not proactive**: the periodic
    health probe is connect-only (it flips the node dot to "down" but never
    relaunches), so a rebooted nohup-fallback node stays "down" until the next
    session create/open on it triggers `ensureRunning` → re-ship + relaunch. For
    automatic reboot survival, give the node user a `systemd --user` bus (the
    linger path, used whenever available). A periodic orchestrator-driven
    re-assert would close the gap (future work; pairs with the local-daemon
    supervisor from T2/T10). See `agentd-bootstrap.ts launch()`.
- **Version negotiation:** every connection starts with `hello{protocolVersion,
daemonVersion}`. On mismatch the orchestrator pushes the new binary and restarts
  the unit (graceful: drain → re-exec; sessions' metadata persisted, PTYs
  respawned only if the re-exec can't hand off fds — v1 accepts a restart blip,
  documented).
- **Security:** loopback-only bind + a per-node shared secret in the `hello`
  (defense in depth on top of SSH). The daemon runs as the SSH user; it can do
  anything that user can — same trust model as today's `transport.exec`.

## 6. Protocol

Framed, multiplexed, one channel. Frame = `uint32 length | uint8 type | payload`.

- **Control frames** (JSON for v1; msgpack later): `hello`, `openSession`,
  `closeSession`, `subscribe`/`unsubscribe`, `resize`, `listSessions`,
  `getLayout`/`setLayout`, and event pushes `status`, `exit`, `hook`.
- **Data frames** (binary, session-tagged): `ptyOutput{sessionId, bytes}`,
  `ptyInput{sessionId, bytes}`. Per-session credit-based backpressure (absorbs
  the old `BandwidthController` concern).

The **contract is the single source of truth**: the TS side is
`apps/orchestrator/src/nodes/agentd/protocol.ts` and the Go side mirrors it in
`agentd/internal/proto/proto.go` (hand-written structs). This is the one artifact
that is _never_ throwaway. (The original design proposed a `@flock/shared` module;
as-built it lives in the orchestrator's agentd client package.)

## 7. Session + scrollback + resize

- `openSession{kind: 'agent'|'shell', cwd, env, command}` → daemon spawns the
  command in a **raw PTY**, returns `sessionId`. Agent sessions get the hook env
  (pointed at the daemon itself in v2).
- Each session keeps a **scrollback ring** (e.g. 2 MB, configurable). On
  `subscribe` the daemon replays the ring then streams live → reconnect-resume,
  reliable and native (replaces the tmux capture-pane hack).
- `resize{sessionId, cols, rows}` → `pty.Setsize` → SIGWINCH. Direct; no tmux
  window-size policy, no DA probe, no status bar. **This is the fix for every
  terminal bug we hit.**
- `exit{sessionId, code}` pushed when the process ends.

## 8. Layout (server-authoritative)

- The daemon stores a **workspace layout** per agent-session-group: a pane tree
  (`{ direction, children: [paneLeaf | splitNode], sizes }`) where leaves bind to
  `sessionId`s. Persisted to `~/.flock/state/<workspace>.json`.
- `getLayout` on (re)connect → orchestrator → browser rebuilds the splits and
  subscribes to each pane's session (scrollback replays). `setLayout` on user
  edits (split/close/resize) syncs back. → true "come back and it's all there."

## 9. What it absorbs (migration order)

| Today                                | Becomes                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| tmux PTYs + capture-pane resume      | daemon raw PTYs + scrollback ring                              |
| reverse SSH tunnel for hooks         | agent hooks `curl` daemon loopback → `hook` event frames       |
| `transport.exec` fs/git/path-browser | daemon `fs.*`/`git.*` ops (streaming, `fs.watch`)              |
| OSC/PTY status scraping + reconcile  | daemon parses PTY, pushes `status`; reconcile = `listSessions` |

## 10. v1 scope (tight: replace the broken thing + lay the foundation)

**In:** Go daemon; bootstrap-over-SSH (install/start/version) for Linux nodes;
loopback listener; framed protocol over SSH `direct-tcpip` + local unix socket;
PTY sessions (agent + shell) with input/output/resize/close; scrollback ring +
reconnect-resume; server-authoritative layout get/set + disk persistence;
orchestrator `NodeAgentClient` bridging the daemon to the existing `/ws/pty` so
the **browser UI is untouched**.

**Out (v2+):** fs/git/hooks/status migration; macOS/Windows; computer-use;
node-reboot session resurrection polish; msgpack; codegen for the Go contract.

**Done = parity:** a Flock session's terminal + clean resizable splits run on the
daemon over SSH, survive orchestrator restart with scrollback + layout intact, and
the `0;276;0c` / short-pane / window-size bugs are gone by construction.

## 11. Reused vs replaced (so nothing is wasted)

- **Reused (the bulk):** all browser terminal/split/layout/fit code, file browser,
  drag/drop, sidebar status, icon tabs, `SupervisedSshConnection`, the
  per-session-token + auth model, the `/ws/pty` browser contract.
- **Replaced (small):** tmux attach commands, the `:shell` resolve, the
  `vt-reports` DA strip (no tmux probe → unneeded), resize-to-tmux plumbing, the
  reverse-tunnel-for-hooks (eventually).

## 12. Open decisions to lock before building

1. **Language: Go (recommended) vs Node.** (§3)
2. **Transport: SSH `direct-tcpip` to a loopback port (recommended) vs daemon-over-
   SSH-stdio.** (§4)
3. **Supervision: `systemd --user` + linger (recommended) vs custom watchdog.** (§5)
4. **v1 OS targets: Linux-only first?** (yes, recommended.)
5. **Persistence depth for v1: in-memory across orchestrator reconnect + metadata/
   layout on disk; respawn (not live-restore) on daemon restart.** (confirm.)

## 13. Risks

- **Distribution/upgrade** is the real risk, not the PTY code → mitigated by
  ship-over-SSH + version negotiation + systemd.
- **Persistence-done-wrong** is worse than tmux → mitigated by scoping v1 to
  orchestrator-reconnect persistence (the daemon staying up) and being explicit
  that node-reboot loses live state (= tmux parity).
- **Scope creep ("for everything")** → mitigated by the v1/v2 split: ship PTY +
  layout parity first; migrate fs/git/hooks only after.
