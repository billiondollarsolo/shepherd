// Package session owns the node-side PTYs that flock-agentd manages — the raw
// replacement for tmux. Each Session spawns a command in a pseudo-terminal,
// keeps a bounded scrollback ring for reconnect-resume, and fans live output to
// any number of subscribers. Input and resize go straight to the PTY (no tmux
// window-size indirection), so terminal sizing is exact.
//
// A session with Kind "dev" is SUPERVISED: when its process exits it is
// automatically respawned (with capped backoff) until the session is explicitly
// Closed, so a dev server that crashes — or that you've configured to run
// forever — comes back on its own. The scrollback ring and the subscriber set
// persist across restarts, so the terminal stays attached and simply shows a
// restart banner; clients never disconnect.
package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"flock-agentd/internal/agentpath"
	"flock-agentd/internal/status"

	"github.com/creack/pty"
)

// Spec describes a session to open.
type Spec struct {
	ID      string
	Kind    string // "agent" | "shell" | "dev" (dev → auto-restart on exit)
	Cwd     string
	Env     []string // full environment; nil → inherit
	Command []string // argv; empty → the user's default shell as a login shell
	// Mode selects the transport: "" / "pty" = raw PTY (default, universal); "acp"
	// = structured Agent Client Protocol over stdio (F6). For "acp", Command is the
	// ACP launch argv (e.g. gemini --experimental-acp).
	Mode string
	Cols uint16
	Rows uint16

	// --- scoped hook-config injection (US-19), seeded ON THE NODE ---
	// When ConfigDirEnv is set, Open() creates a per-session scoped config dir on
	// THIS node's filesystem, copies the node user's real config (ConfigBaseSubdir,
	// $HOME-relative) in as a base, writes ConfigFiles into it (substituting the
	// literal "__FLOCK_CONFIG_DIR__" placeholder with the scoped dir's absolute
	// path), and exports ConfigDirEnv=<scopedDir> to the agent — so the agent reads
	// Flock's hook wiring without the orchestrator ever touching the node's fs and
	// without clobbering the user's real config. Removed on Close. Empty = no-op.
	ConfigDirEnv     string            // e.g. "CLAUDE_CONFIG_DIR" / "CODEX_HOME" / "XDG_CONFIG_HOME"
	ConfigFiles      map[string]string // relpath -> content (relpath may include subdirs)
	ConfigBaseSubdir string            // $HOME-relative dir to copy as base ("" = none), e.g. ".claude"

	// --- Landlock FS sandbox for autonomous sessions (T17) ---
	// When Sandbox is true (the orchestrator sets it only for `autonomous` sessions
	// on sandbox-capable nodes), the command is launched through the
	// `flock-agentd sandbox-exec` helper, which Landlock-restricts the agent so it
	// can only WRITE beneath the workspace (Cwd), /tmp, /dev, and SandboxAllow.
	// Reads/execs stay unrestricted. This enforces the isolation that
	// `--dangerously-skip-permissions` otherwise lacks. Empty/false = no sandbox.
	Sandbox      bool
	SandboxAllow []string // extra writable dirs (e.g. a worktree path); Cwd is always allowed

	// ActivityStatus (T61): when set, derive running/idle from PTY OUTPUT ACTIVITY
	// (recent output → running; quiet → idle) instead of a transcript/hook. Set by
	// the orchestrator for agents with no better status source (e.g. gemini), so
	// they get a live dot instead of being stuck. Cannot express awaiting_input.
	ActivityStatus bool
}

// defaultScrollbackBytes is the per-session resume buffer cap (~2 MB).
const defaultScrollbackBytes = 2 << 20

// Dev-session restart supervision tuning.
const (
	devInitialBackoff   = 300 * time.Millisecond
	devMaxBackoff       = 5 * time.Second
	devHealthyThreshold = 3 * time.Second // a run lasting this long resets backoff
)

// Session is a live PTY plus its scrollback and subscribers.
type Session struct {
	spec Spec

	mu       sync.Mutex
	ptmx     *os.File      // current PTY (swapped on each dev restart)
	cmd      *exec.Cmd     // current process
	pumpDone chan struct{} // closed after the current PTY's final bytes reach the ring
	ring     *ring
	subs     map[int]chan []byte
	nextSub  int

	// ACP (structured) mode: non-nil for Mode=="acp" sessions. statusPush sends
	// derived status to the manager (PTY sessions use the manager's status watcher
	// instead). See acp_session.go.
	acp        *acpState
	statusPush func(status.Update)

	// inAlt tracks whether the foreground program is on the ALTERNATE screen (vim,
	// htop, less, a TUI agent). Updated by scanning output for the DEC private-mode
	// switches. altCarry holds the trailing bytes of the last chunk so a switch
	// sequence split across two reads is still detected. See updateAltState.
	inAlt    bool
	altCarry []byte

	exited    bool // CURRENT process has exited (transiently true between dev restarts)
	exitCode  int  // last process exit code
	closed    bool // explicit Close() — stop supervising
	finalized bool // supervision ended; no more output ever

	configDir string // scoped hook-config dir seeded for this session (rm on Close); "" = none

	// lastActivityNanos is the unix-nano timestamp of the most recent PTY output.
	// Read lock-free by the activity-status watcher (T61) to derive running/idle for
	// agents with no transcript/hook status source (e.g. gemini).
	lastActivityNanos atomic.Int64

	closeCh chan struct{} // closed by Close() to interrupt a backoff sleep
	done    chan struct{} // closed once when supervision ends (terminal exit/close)
}

// LastActivity returns the time of the most recent PTY output (zero if none yet).
func (s *Session) LastActivity() time.Time {
	n := s.lastActivityNanos.Load()
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}

// Open spawns the spec's command in a new PTY and starts pumping its output into
// the scrollback ring + subscribers. For a "dev" session a supervisor respawns
// the command on exit until Close(). The caller owns Close().
func Open(spec Spec) (*Session, error) {
	s := &Session{
		spec:    spec,
		ring:    newRing(defaultScrollbackBytes),
		subs:    make(map[int]chan []byte),
		closeCh: make(chan struct{}),
		done:    make(chan struct{}),
	}
	// Seed the scoped hook-config dir on this node BEFORE spawning, so the env var
	// pointing at it is present in the very first process env (US-19, T1).
	if dir, env, err := seedScopedConfig(spec); err != nil {
		// Best-effort: a config-seed failure must not block the agent launching —
		// it just means no hooks for this session. Log to stderr (captured).
		fmt.Fprintf(os.Stderr, "[flock-agentd] scoped config seed failed for %s: %v\n", spec.ID, err)
	} else if dir != "" {
		s.configDir = dir
		s.spec.Env = append(s.spec.Env, env)
	}
	if err := s.startProcess(); err != nil {
		return nil, err
	}
	go s.supervise()
	return s, nil
}

// startProcess spawns the spec's command in a fresh PTY and begins pumping its
// output. It sets s.cmd/s.ptmx (under lock) and starts a pump goroutine bound to
// THIS pty (so a later dev restart's pump is independent). Holds the spawn env
// logic shared by the first launch and every dev restart.
func (s *Session) startProcess() error {
	argv := s.spec.Command
	if len(argv) == 0 {
		argv = []string{defaultShell(), "-l"}
	}
	// T17: for an autonomous session on a sandbox-capable node, run the agent
	// through the `flock-agentd sandbox-exec` helper so Landlock confines its
	// writes to the workspace (+ /tmp, /dev, and any extra allow dirs). Only wrap
	// a real command (never the bare login shell). If we can't resolve our own
	// binary we fall back to running unconfined (the orchestrator has already
	// warned for unsandboxed launches).
	if s.spec.Sandbox && len(s.spec.Command) > 0 {
		if self, err := os.Executable(); err == nil {
			wrapped := []string{self, "sandbox-exec"}
			allow := append([]string{s.spec.Cwd, "/tmp", "/dev"}, s.spec.SandboxAllow...)
			for _, dir := range allow {
				if dir != "" {
					wrapped = append(wrapped, "--allow", dir)
				}
			}
			wrapped = append(wrapped, "--")
			wrapped = append(wrapped, argv...)
			argv = wrapped
		}
	}
	// Resolve argv[0] to an ABSOLUTE path against the augmented agent bin dirs.
	// CRITICAL: exec.Command resolves a bare name via exec.LookPath using the
	// DAEMON's own $PATH — it IGNORES cmd.Env. So a minimal systemd/nohup daemon
	// (whose $PATH lacks ~/.local/bin, ~/.nvm/.../bin, …) would never find a
	// userland-installed agent (gemini/opencode), even though cmd.Env's PATH below
	// is augmented. Resolving here (same dirs as the spawn PATH) is what actually
	// lets those launch; claude/codex in /usr/bin resolve via LookPath as before.
	cmd := exec.Command(resolveExecutable(argv[0]), argv[1:]...)
	if s.spec.Cwd != "" {
		cmd.Dir = s.spec.Cwd
	}
	// spec.Env are ADDITIONS (e.g. the Flock hook vars) merged over the daemon's
	// own environment, so the agent still inherits PATH/HOME/etc. from the node.
	// PATH augmentation: a systemd/nohup-launched daemon has a MINIMAL $PATH that
	// usually excludes Node version-manager / npm-global bin dirs (~/.nvm/.../bin,
	// ~/.local/bin, …) — exactly where claude/codex/gemini/opencode install. Without
	// this, a bare `gemini`/`codex` argv fails with "not found" on such nodes even
	// though detection found it. Prepend the agent bin dirs to PATH (a later env
	// entry wins; spec.Env may still override PATH after this).
	// Hand the agent a base env WITHOUT the daemon's PRIVATE auth secret: the
	// coding agent (and any tool/subprocess/code it runs) must never read
	// FLOCK_AGENTD_SECRET from its own environment and impersonate the
	// orchestrator to this daemon.
	base := os.Environ()
	filtered := make([]string, 0, len(base)+4)
	for _, e := range base {
		if strings.HasPrefix(e, "FLOCK_AGENTD_SECRET=") {
			continue
		}
		filtered = append(filtered, e)
	}
	cmd.Env = append(filtered, "PATH="+augmentedPath())
	cmd.Env = append(cmd.Env, s.spec.Env...)
	// The PTY's terminal type must match the CLIENT (the browser's xterm.js),
	// NOT whatever the daemon inherited — so FORCE TERM=xterm-256color, overriding
	// any daemon TERM (a later entry wins in exec env). Without a correct TERM,
	// bash/readline can't position the cursor and reprints its prompt as plain text
	// on every resize (the "flock@host:~$ flock@host:~$ …" smear), and full-screen
	// agent TUIs degrade. The caller (spec.Env) may still override. C.UTF-8 (only
	// if the daemon has no locale) keeps box-drawing/glyphs correct.
	if !hasEnvKey(s.spec.Env, "TERM") {
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	}
	if !hasEnvKey(s.spec.Env, "LANG") && !hasEnvKey(cmd.Env, "LANG") {
		cmd.Env = append(cmd.Env, "LANG=C.UTF-8")
	}
	ws := &pty.Winsize{Rows: orDefault(s.spec.Rows, 24), Cols: orDefault(s.spec.Cols, 80)}
	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.ptmx = ptmx
	s.cmd = cmd
	pumpDone := make(chan struct{})
	s.pumpDone = pumpDone
	s.exited = false
	// Record the ACTUAL size the PTY opened at so Resize can skip a redundant
	// SIGWINCH (TIOCSWINSZ fires SIGWINCH even when the size is unchanged, which
	// makes bash reprint its prompt — that redraw piles up in the scrollback and
	// replays on every attach: the "flock@host:~$ flock@host:~$ …" artifact).
	s.spec.Cols = ws.Cols
	s.spec.Rows = ws.Rows
	s.mu.Unlock()
	go func() {
		defer close(pumpDone)
		s.pump(ptmx)
	}()
	return nil
}

// ID returns the session id.
func (s *Session) ID() string { return s.spec.ID }

// Spec returns a copy of the session's spec. Locked: startProcess/Resize mutate
// spec.Cols/Rows under s.mu, so an unsynchronized read here is a data race.
func (s *Session) SpecValue() Spec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec
}

// PID returns the running process's PID, or 0 when no process is live (between a
// dev-session restart, or after exit). Used for per-session resource metrics.
func (s *Session) PID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil && !s.exited {
		return s.cmd.Process.Pid
	}
	return 0
}

// pump reads one PTY's output into the ring and fans it to subscribers. A slow
// subscriber backpressures the reader (and thus the program) — correct flow
// control. Ends when this PTY closes (the process exited or was restarted).
func (s *Session) pump(ptmx *os.File) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] pump panic (session %s): %v\n", s.spec.ID, r)
		}
	}()
	buf := make([]byte, 32*1024)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.broadcast(chunk)
		}
		if err != nil {
			return
		}
	}
}

// Alternate-screen switch sequences (DEC private modes). 1049 is the modern one
// (save cursor + switch + clear); 47 / 1047 are the legacy variants. The leading
// "\x1b[?" disambiguates 47 from 1047/1049, so plain substring search is safe.
var (
	altEnters = [][]byte{[]byte("\x1b[?1049h"), []byte("\x1b[?1047h"), []byte("\x1b[?47h")}
	altExits  = [][]byte{[]byte("\x1b[?1049l"), []byte("\x1b[?1047l"), []byte("\x1b[?47l")}
	// Common prefix of every alt-screen switch; absence ⇒ no switch in the chunk.
	altIntro = []byte("\x1b[?")
)

// altCarryLen keeps enough trailing bytes to span the longest switch sequence
// across a chunk boundary ("\x1b[?1049h"/"l" is 8 bytes → carry the last 7).
const altCarryLen = 7

// updateAltState updates s.inAlt from one output chunk. The LAST enter/exit in the
// scanned window wins, so multiple toggles in one chunk resolve correctly. Because
// the state is a boolean, re-seeing a carried sequence is idempotent (harmless).
// Caller must hold s.mu.
func (s *Session) updateAltState(chunk []byte) {
	buf := chunk
	if len(s.altCarry) > 0 {
		buf = append(append(make([]byte, 0, len(s.altCarry)+len(chunk)), s.altCarry...), chunk...)
	}
	// Fast path: every alt-screen switch starts with the DEC private-mode intro
	// "\x1b[?". The vast majority of output chunks contain none, so one cheap scan
	// here skips the six LastIndex scans below. inAlt can't change without an intro
	// present, so this is behavior-preserving; the carry is still updated so a
	// sequence split across chunks is caught on the next call.
	if !bytes.Contains(buf, altIntro) {
		s.saveAltCarry(buf)
		return
	}
	lastE, lastX := -1, -1
	for _, n := range altEnters {
		if i := bytes.LastIndex(buf, n); i > lastE {
			lastE = i
		}
	}
	for _, n := range altExits {
		if i := bytes.LastIndex(buf, n); i > lastX {
			lastX = i
		}
	}
	if lastE >= 0 || lastX >= 0 {
		s.inAlt = lastE > lastX
	}
	s.saveAltCarry(buf)
}

// saveAltCarry keeps the last altCarryLen bytes so a switch sequence split across
// two output chunks is still detected when the next chunk arrives.
func (s *Session) saveAltCarry(buf []byte) {
	if len(buf) > altCarryLen {
		s.altCarry = append(s.altCarry[:0], buf[len(buf)-altCarryLen:]...)
	} else {
		s.altCarry = append(s.altCarry[:0], buf...)
	}
}

// broadcast appends a chunk to the ring and fans it to all current subscribers.
//
// The fan-out is NON-BLOCKING and done UNDER s.mu. Non-blocking: a slow/congested
// subscriber (its buffer full) is SKIPPED for this chunk rather than blocking the
// pump — which would otherwise flow-control the agent process to a halt and (via
// the connection's shared write mutex) stall every other session on the node. The
// ring still holds the chunk, so a reattach replays it and the live view self-heals
// on the next repaint. Under s.mu: this is mutually exclusive with finalize()'s
// close(ch), so we can never send on a closed channel (the daemon-crashing panic).
func (s *Session) broadcast(chunk []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finalized {
		return
	}
	// T61: record output time for the activity-status watcher (lock-free read).
	s.lastActivityNanos.Store(time.Now().UnixNano())
	wasAlt := s.inAlt
	s.updateAltState(chunk)
	ringChunk := chunk
	if wasAlt && !s.inAlt {
		// Program LEFT the alternate screen (e.g. quit htop/vim): the alt frames now
		// in the ring are stale — the real terminal restored the pre-alt screen — so a
		// later reattach (which takes the normal-screen replay path) would paint them
		// as garbage. Reset scrollback to a clean normal screen and keep only THIS
		// chunk's post-exit tail. Live subscribers still get the FULL chunk below.
		s.ring.reset()
		s.ring.write([]byte("\x1b[?1049l\x1b[2J\x1b[3J\x1b[H"))
		ringChunk = tailAfterAltExit(chunk)
	}
	s.ring.write(ringChunk)
	for _, ch := range s.subs {
		select {
		case ch <- chunk:
		default:
			// subscriber buffer full → drop this chunk for it (see doc above).
		}
	}
}

// tailAfterAltExit returns the portion of chunk AFTER its last alt-screen-exit
// sequence, so the stale alt frames preceding it aren't retained in scrollback.
func tailAfterAltExit(chunk []byte) []byte {
	end := -1
	for _, x := range altExits {
		if i := bytes.LastIndex(chunk, x); i >= 0 && i+len(x) > end {
			end = i + len(x)
		}
	}
	if end < 0 {
		return chunk
	}
	return chunk[end:]
}

// supervise waits for the current process and, for a "dev" session, respawns it
// with capped backoff until Close(). For any other kind it finalizes on the
// first exit (identical to the pre-supervision behaviour).
func (s *Session) supervise() {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] supervise panic (session %s): %v\n", s.spec.ID, r)
			s.finalize()
		}
	}()
	backoff := devInitialBackoff
	for {
		s.mu.Lock()
		cmd := s.cmd
		pumpDone := s.pumpDone
		s.mu.Unlock()

		start := time.Now()
		err := cmd.Wait()
		// Wait may reap a short-lived child before the PTY reader is scheduled.
		// Let the pump drain the kernel buffer before finalize marks the session
		// closed; otherwise fast commands can nondeterministically lose all output.
		<-pumpDone

		s.mu.Lock()
		s.exited = true
		s.exitCode = exitCodeOf(err)
		code := s.exitCode
		stop := s.closed || s.spec.Kind != "dev"
		s.mu.Unlock()

		if stop {
			break
		}

		// A run that stayed up long enough is "healthy" → reset the backoff so an
		// occasional crash restarts fast; a tight crash-loop backs off instead.
		if time.Since(start) >= devHealthyThreshold {
			backoff = devInitialBackoff
		}
		s.broadcast(devRestartBanner(code, backoff))
		if s.sleepOrClosed(backoff) {
			break
		}
		backoff = capDuration(backoff*2, devMaxBackoff)

		if err := s.startProcess(); err != nil {
			s.broadcast([]byte(fmt.Sprintf("\r\n\x1b[31m[dev] restart failed: %v\x1b[0m\r\n", err)))
			if s.sleepOrClosed(backoff) {
				break
			}
			continue
		}
	}
	s.finalize()
}

// sleepOrClosed waits for d, or returns true early if Close() was called.
func (s *Session) sleepOrClosed(d time.Duration) bool {
	select {
	case <-time.After(d):
		return false
	case <-s.closeCh:
		return true
	}
}

// finalize ends the session for good: close every subscriber and the done chan.
func (s *Session) finalize() {
	s.mu.Lock()
	s.finalized = true
	for _, ch := range s.subs {
		close(ch)
	}
	s.subs = map[int]chan []byte{}
	dir := s.configDir
	s.configDir = ""
	s.mu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(dir) // remove the scoped hook-config on session end
	}
	close(s.done)
}

// Write sends input bytes to the current PTY (keystrokes, pasted text). During a
// dev restart's brief gap the PTY may be unavailable; the write is then dropped.
func (s *Session) Write(p []byte) error {
	s.mu.Lock()
	acpState := s.acp
	ptmx := s.ptmx
	exited := s.exited
	s.mu.Unlock()
	// ACP sessions have no PTY — input is line-edited then sent as a prompt (or a
	// permission answer). See acp_session.go.
	if acpState != nil {
		return s.acpInput(p)
	}
	if ptmx == nil || exited {
		return nil
	}
	_, err := ptmx.Write(p)
	return err
}

// Resize sets the current PTY window size; the foreground program gets SIGWINCH.
// The size is remembered on the spec so a dev restart re-opens at the same size.
func (s *Session) Resize(cols, rows uint16) error {
	c, r := orDefault(cols, 80), orDefault(rows, 24)
	s.mu.Lock()
	// Dedup: an unchanged size must NOT re-fire SIGWINCH (it makes bash/zsh reprint
	// their prompt, which accumulates in the scrollback and replays on attach).
	if s.spec.Cols == c && s.spec.Rows == r {
		s.mu.Unlock()
		return nil
	}
	s.spec.Cols = c
	s.spec.Rows = r
	ptmx := s.ptmx
	s.mu.Unlock()
	if ptmx == nil {
		return nil
	}
	return pty.Setsize(ptmx, &pty.Winsize{Rows: r, Cols: c})
}

// Subscription is a live output stream plus the scrollback snapshot to replay
// first. Call Close to unsubscribe.
type Subscription struct {
	// Replay is the scrollback at subscribe time (write it to the client first).
	Replay []byte
	// Output streams live PTY bytes; closed when the session is finalized.
	Output <-chan []byte
	close  func()
}

// Close unsubscribes (idempotent).
func (sub *Subscription) Close() { sub.close() }

// Subscribe returns the current scrollback to replay plus a live output channel.
// A subscribe during a dev restart's gap still attaches (output resumes after
// the respawn); only a finalized session yields an already-closed channel.
func (s *Session) Subscribe() *Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Replay strategy depends on the screen the foreground program is using:
	//   - NORMAL screen (a shell): replay the scrollback ring — that's the user's
	//     real history and it repaints cleanly.
	//   - ALTERNATE screen (vim/htop/TUI): the ring is a stream of frame redraws
	//     sized to the OLD viewport, and the alt-screen ENTER may have scrolled out
	//     of the ring entirely. Replaying it paints garbage. Instead put the client
	//     in a CLEAN alt buffer and let the program repaint itself (forced SIGWINCH
	//     below) — exactly how reattaching to a tmux session running vim/htop behaves.
	var replay []byte
	if s.inAlt {
		replay = []byte("\x1b[?1049h\x1b[H\x1b[2J")
	} else {
		replay = s.ring.snapshot()
	}
	ch := make(chan []byte, 256)
	if s.finalized {
		close(ch)
		return &Subscription{Replay: replay, Output: ch, close: func() {}}
	}
	id := s.nextSub
	s.nextSub++
	s.subs[id] = ch
	// For a full-screen app, force a FULL repaint for the freshly attached client
	// (we cleared its buffer above). A SAME-size SIGWINCH is NOT enough: a diff-
	// rendering TUI (htop) only repaints the cells IT thinks changed against its own
	// (now stale) buffer → scattered rows with gaps. A single row jiggle is also not
	// enough for some agents (OpenCode): after painting at HxW they ignore H-1→H.
	// Jiggle BOTH dims with gaps so the layout change is real, then restore.
	// Async (off s.mu). NOT done for a normal-screen shell — SIGWINCH there makes
	// bash/zsh reprint their prompt (the double-prompt smear).
	if s.inAlt && s.ptmx != nil {
		ptmx := s.ptmx
		rows, cols := orDefault(s.spec.Rows, 24), orDefault(s.spec.Cols, 80)
		rowJ := rows - 1
		if rowJ < 1 {
			rowJ = rows + 1
		}
		colJ := cols - 1
		if colJ < 1 {
			colJ = cols + 1
		}
		go func() {
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: rowJ, Cols: cols})
			time.Sleep(100 * time.Millisecond)
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: colJ})
			time.Sleep(100 * time.Millisecond)
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: cols})
		}()
	}
	return &Subscription{
		Replay: replay,
		Output: ch,
		close: func() {
			s.mu.Lock()
			if c, ok := s.subs[id]; ok {
				delete(s.subs, id)
				close(c)
			}
			s.mu.Unlock()
		},
	}
}

// Exited reports whether the CURRENT process has exited, and its last code. For a
// dev session this is transiently true between restarts; use Done() to detect a
// terminal end.
func (s *Session) Exited() (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exited, s.exitCode
}

// Done is closed when the session ends for good (terminal exit or Close()).
func (s *Session) Done() <-chan struct{} { return s.done }

// Close terminates the process and stops supervision (idempotent). For a dev
// session this is the ONLY thing that ends it — a crash just restarts.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		ptmx := s.ptmx
		s.ptmx = nil
		s.mu.Unlock()
		if ptmx != nil {
			_ = ptmx.Close()
		}
		return nil
	}
	s.closed = true
	close(s.closeCh)
	cmd := s.cmd
	ptmx := s.ptmx
	// Null the PTY UNDER the lock BEFORE closing its fd. Every other reader
	// (ForegroundComm's TIOCGPGRP ioctl, Write, Resize) reads s.ptmx under s.mu
	// and nil-checks, so once it's nil they can never touch a closed/reused fd —
	// this closes the fd use-after-close window on terminal teardown.
	s.ptmx = nil
	s.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if ptmx != nil {
		return ptmx.Close()
	}
	return nil
}

// Terminate is the GRACEFUL counterpart to Close: it stops the restart loop and
// sends SIGTERM (not SIGKILL) so the agent can flush state/transcripts, then lets
// the caller wait on Done() before a hard Close() reaps any straggler. Used on
// daemon shutdown.
func (s *Session) Terminate() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.closeCh)
	cmd := s.cmd
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
}

func orDefault(v, d uint16) uint16 {
	if v == 0 {
		return d
	}
	return v
}

func capDuration(v, max time.Duration) time.Duration {
	if v > max {
		return max
	}
	return v
}

// devRestartBanner is the dim line injected into the stream between dev restarts.
func devRestartBanner(code int, wait time.Duration) []byte {
	return []byte(fmt.Sprintf(
		"\r\n\x1b[2m↻ dev process exited (code %d) — restarting in %s…\x1b[0m\r\n",
		code, wait.Round(time.Millisecond),
	))
}

// hasEnvKey reports whether env contains a `key=…` entry.
func hasEnvKey(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

// seedScopedConfig builds the per-session scoped hook-config dir on THIS node
// (US-19, T1). Returns the dir + the `ENV=dir` entry to append to the spawn env,
// or ("","",nil) when no scoped config was requested. The user's real config is
// copied in as a base (never edited); Flock's files are layered on top with the
// "__FLOCK_CONFIG_DIR__" placeholder replaced by the absolute scoped path.
func seedScopedConfig(spec Spec) (dir string, envEntry string, err error) {
	if len(spec.ConfigFiles) == 0 {
		return "", "", nil
	}

	// NATIVE install (no ConfigDirEnv): write Flock's hook files straight into the
	// agent's REAL config dir ($HOME/<ConfigBaseSubdir>) and DON'T override the
	// config dir — so the agent uses its native config, auth, transcript, and
	// onboarding (the node is treated as a pre-configured machine). No scoped dir,
	// no env entry, nothing to clean up on close; the forwarder/plugin no-op
	// without the per-session FLOCK_HOOK_* env, so non-Flock runs are unaffected.
	if spec.ConfigDirEnv == "" {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", "", herr
		}
		target := filepath.Join(home, spec.ConfigBaseSubdir)
		if mderr := os.MkdirAll(target, 0o700); mderr != nil {
			return "", "", mderr
		}
		return "", "", writeConfigFiles(target, spec.ConfigFiles)
	}

	// SCOPED install (legacy isolation): a per-session COPY of the user's config dir
	// with Flock's files layered on top, reached via ConfigDirEnv=<scoped dir>.
	dir = filepath.Join(os.TempDir(), "flock-session-config-"+spec.ID)
	_ = os.RemoveAll(dir) // clear any stale dir from a prior crashed run
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	if spec.ConfigBaseSubdir != "" {
		if home, herr := os.UserHomeDir(); herr == nil {
			src := filepath.Join(home, spec.ConfigBaseSubdir)
			if fi, serr := os.Stat(src); serr == nil && fi.IsDir() {
				if cerr := copyDir(src, dir); cerr != nil {
					fmt.Fprintf(os.Stderr, "[flock-agentd] config base copy %s: %v\n", src, cerr)
				}
			}
		}
	}
	if err = writeConfigFiles(dir, spec.ConfigFiles); err != nil {
		return "", "", err
	}
	return dir, spec.ConfigDirEnv + "=" + dir, nil
}

// writeConfigFiles writes Flock's hook files into targetDir, replacing the
// __FLOCK_CONFIG_DIR__ placeholder with targetDir and DEEP-MERGING into any
// existing JSON (so the user's own settings/hooks are preserved, and re-running on
// a native dir is idempotent). Shared by the native + scoped install paths.
func writeConfigFiles(targetDir string, files map[string]string) error {
	for rel, content := range files {
		full := filepath.Join(targetDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return err
		}
		body := []byte(strings.ReplaceAll(content, "__FLOCK_CONFIG_DIR__", targetDir))
		mode := os.FileMode(0o644)
		if strings.HasSuffix(rel, ".sh") {
			mode = 0o755 // the hook forwarder must be executable
		}
		// Merge into an existing JSON (e.g. the user's own settings.json) rather than
		// clobbering their model/statusline/custom hooks.
		if strings.HasSuffix(rel, ".json") {
			if existing, rerr := os.ReadFile(full); rerr == nil {
				if merged, ok := mergeHookSettings(existing, body); ok {
					body = merged
				}
			}
		}
		if err := os.WriteFile(full, body, mode); err != nil {
			return err
		}
	}
	return nil
}

// mergeHookSettings deep-merges Flock's settings JSON into the user's existing
// settings JSON: every top-level key from Flock wins EXCEPT `hooks`, where each
// event's hook array is APPENDED to the user's (so the user's own hooks survive
// alongside Flock's). Returns (merged, true) on success, (_, false) if either
// side isn't a JSON object (caller then keeps Flock's content as-is).
func mergeHookSettings(existing, flock []byte) ([]byte, bool) {
	var user, add map[string]any
	if json.Unmarshal(existing, &user) != nil || json.Unmarshal(flock, &add) != nil {
		return nil, false
	}
	for k, v := range add {
		if k == "hooks" {
			user[k] = mergeHooksMap(user["hooks"], v)
			continue
		}
		user[k] = v
	}
	out, err := json.MarshalIndent(user, "", "  ")
	if err != nil {
		return nil, false
	}
	return out, true
}

// mergeHooksMap appends Flock's per-event hook arrays to the user's existing ones.
func mergeHooksMap(userHooks, flockHooks any) any {
	fm, ok := flockHooks.(map[string]any)
	if !ok {
		return flockHooks
	}
	um, ok := userHooks.(map[string]any)
	if !ok {
		um = map[string]any{}
	}
	for event, fEntries := range fm {
		fArr, _ := fEntries.([]any)
		existing, _ := um[event].([]any)
		// Append only entries not already present. The SAME scoped config is
		// re-seeded on every session open, so a plain append would accumulate
		// duplicate Flock hooks on disk (→ the agent fires the forwarder N times =
		// N duplicate hook events). Idempotent merge keeps the user's own hooks AND
		// avoids dup-stacking ours.
		for _, fe := range fArr {
			if !containsJSONEqual(existing, fe) {
				existing = append(existing, fe)
			}
		}
		um[event] = existing
	}
	return um
}

// containsJSONEqual reports whether arr already holds an element JSON-equal to v
// (makes hook merging idempotent across re-seeds).
func containsJSONEqual(arr []any, v any) bool {
	vb, err := json.Marshal(v)
	if err != nil {
		return false
	}
	for _, e := range arr {
		if eb, err := json.Marshal(e); err == nil && bytes.Equal(eb, vb) {
			return true
		}
	}
	return false
}

// copyDir recursively copies regular files + dirs from src into dst (best-effort;
// symlinks/special files are skipped). Used to layer the node user's real agent
// config as a base under the scoped dir.
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries rather than abort the whole copy
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !d.Type().IsRegular() {
			return nil // skip symlinks/sockets/etc.
		}
		data, rderr := os.ReadFile(path)
		if rderr != nil {
			return nil
		}
		info, _ := d.Info()
		mode := os.FileMode(0o600)
		if info != nil {
			mode = info.Mode().Perm()
		}
		return os.WriteFile(target, data, mode)
	})
}

func defaultShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// augmentedPath returns the daemon's $PATH with the shared agent-install bin dirs
// (agentpath.BinDirs — same source of truth as metrics.resolveAgent) appended, so
// npm / version-manager-installed agents (claude/codex/gemini/opencode) launch even
// under a minimal systemd/nohup $PATH.
//
// Recomputed on EVERY spawn — deliberately NOT cached. An agent can be installed
// AFTER the daemon starts (e.g. a userland `npm i -g` into ~/.local/bin); BinDirs
// only includes dirs that exist at call time, so a once-cached PATH would omit
// that dir forever and the daemon would keep failing to launch the agent even
// though detection (which rescans every 30s) shows it as present. The ~20
// stat/glob syscalls per spawn are negligible — spawns are user-initiated + rare.
func augmentedPath() string {
	path := os.Getenv("PATH")
	home, _ := os.UserHomeDir()
	for _, d := range agentpath.BinDirs(home) {
		if !pathContains(path, d) {
			path = path + string(os.PathListSeparator) + d
		}
	}
	return path
}

// resolveExecutable maps a bare command name (argv[0]) to an absolute path,
// searching the SAME augmented bin dirs as the spawn PATH (agentpath.BinDirs —
// the source of truth shared with metrics.resolveAgent detection). This is
// REQUIRED because exec.Command/LookPath resolves a bare name against the daemon's
// OWN $PATH and ignores cmd.Env, so an agent in ~/.local/bin (etc.) installed
// after / outside the daemon's minimal $PATH would otherwise fail with "not
// found". A name that already contains a separator, or is on the daemon's own
// PATH, is used as-is. Returns the input unchanged when nothing resolves, so the
// caller still surfaces a clean exec error.
func resolveExecutable(name string) string {
	if name == "" || strings.ContainsRune(name, os.PathSeparator) {
		return name
	}
	// Prefer the agent bin dirs in BinDirs order (USER-LOCAL first: ~/.local/bin
	// before /usr/bin) — the same order as the spawn PATH — so a user-owned install
	// (e.g. claude via the official installer in ~/.local/bin) wins over a root-owned
	// /usr/bin copy that the agent user can't self-update. Fall back to the daemon's
	// own PATH (LookPath) for anything outside these dirs.
	home, _ := os.UserHomeDir()
	for _, dir := range agentpath.BinDirs(home) {
		cand := filepath.Join(dir, name)
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return cand
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p // outside the known bin dirs but on the daemon's $PATH
	}
	return name
}

func pathContains(path, dir string) bool {
	for _, p := range strings.Split(path, string(os.PathListSeparator)) {
		if p == dir {
			return true
		}
	}
	return false
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return -1
}
