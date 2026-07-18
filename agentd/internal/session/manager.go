package session

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/metrics"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// Manager is the registry of live sessions on this node. Sessions persist here
// across orchestrator disconnects (the daemon stays up) — that's the whole point
// vs a raw SSH-exec PTY that dies with its connection.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session

	// Agent status fan-out (derived by tailing each agent's transcript). Kept
	// here so it shares the session lifecycle: a watcher starts with its session
	// and is cancelled when the session closes/exits.
	statusMu     sync.Mutex
	statusSubs   map[int]chan StatusEvent
	statusNext   int
	lastStatus   map[string]StatusEvent        // current state per session (for replay)
	statusStops  map[string]context.CancelFunc // per-session watcher cancel
	claimedFiles map[string]string             // transcript path → owning session id
	creating     map[string]chan struct{}      // ids with an in-flight Open (dedup)

	procMu      sync.Mutex
	procSamples map[string]procSample // last CPU sample per session (for delta %)
}

func NewManager() *Manager {
	return &Manager{
		sessions:     make(map[string]*Session),
		statusSubs:   make(map[int]chan StatusEvent),
		lastStatus:   make(map[string]StatusEvent),
		statusStops:  make(map[string]context.CancelFunc),
		claimedFiles: make(map[string]string),
		creating:     make(map[string]chan struct{}),
		procSamples:  make(map[string]procSample),
	}
}

// Open creates a session (or returns the existing one for the same id, so a
// reconnect re-attaches instead of spawning a duplicate).
func (m *Manager) Open(spec Spec) (*Session, error) {
	if spec.ID == "" {
		return nil, fmt.Errorf("session id required")
	}
	// Dedup concurrent opens of the SAME id without serializing opens of DIFFERENT
	// ids (which holding m.mu across the spawn would do). The first caller registers
	// an in-flight channel + does the real spawn; racers wait on it, then return the
	// resulting session. Prevents two spawned processes + a leaked Session for one id.
	for {
		m.mu.Lock()
		if existing, ok := m.sessions[spec.ID]; ok {
			m.mu.Unlock()
			return existing, nil
		}
		if ch, inflight := m.creating[spec.ID]; inflight {
			m.mu.Unlock()
			<-ch // wait for the in-flight open to finish, then re-check the map
			continue
		}
		ch := make(chan struct{})
		m.creating[spec.ID] = ch
		m.mu.Unlock()

		// Pre-accept the agent's folder-trust gate for this cwd so the session starts
		// READY — not blocked on an onboarding/trust prompt (which also eats the first
		// piped input). Best-effort + non-destructive.
		ensureFolderTrust(detectSetupAgent(spec.Command), spec.Cwd, spec.Identity)

		var s *Session
		var err error
		switch spec.Mode {
		case "acp":
			// Structured transport (F6): the ACP session pushes its own derived
			// status straight to the manager (no transcript/PTY watcher needed).
			s, err = OpenACP(spec, func(u status.Update) {
				m.emitStatus(StatusEvent{ID: spec.ID, Update: u})
			})
		case "claude-stream":
			// Claude's structured stream-json transport: like ACP, it pushes its own
			// derived status straight to the manager (no transcript/PTY watcher).
			s, err = OpenClaudeStream(spec, func(u status.Update) {
				m.emitStatus(StatusEvent{ID: spec.ID, Update: u})
			})
		case "codex-app-server":
			// Codex's structured app-server (JSON-RPC) transport: like ACP + claude-stream,
			// it pushes its own derived status straight to the manager (no watcher).
			s, err = OpenCodexAppServer(spec, func(u status.Update) {
				m.emitStatus(StatusEvent{ID: spec.ID, Update: u})
			})
		default:
			s, err = Open(spec)
		}
		m.mu.Lock()
		delete(m.creating, spec.ID)
		if err == nil {
			m.sessions[spec.ID] = s
		}
		close(ch)
		m.mu.Unlock()
		if err != nil {
			return nil, err
		}

		// Start deriving live status — transcript tail (claude/codex) or PTY-activity
		// (via spec.ActivityStatus); no-op for plain shells. ACP and
		// claude-stream sessions push their own status (above), so they skip the watcher.
		if spec.Mode != "acp" && spec.Mode != "claude-stream" && spec.Mode != "codex-app-server" {
			m.startStatusWatcher(spec, s)
		}

		// Auto-remove from the registry when the process exits.
		go func() {
			<-s.Done()
			m.mu.Lock()
			if m.sessions[spec.ID] == s {
				delete(m.sessions, spec.ID)
			}
			m.mu.Unlock()
			m.stopStatusWatcher(spec.ID)
		}()
		return s, nil
	}
}

// Get returns a live session by id, or nil.
func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// Close terminates and removes a session.
func (m *Manager) Close(id string) {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	m.stopStatusWatcher(id)
	if s != nil {
		_ = s.Close()
	}
}

// List returns the specs of all live sessions (for listSessions / reconcile).
func (m *Manager) List() []Spec {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Spec, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s.SpecValue())
	}
	return out
}

// ProcessRoots returns a bounded point-in-time mapping of Shepherd session IDs
// to their current root PIDs. Listener discovery uses this to associate child
// development servers without exposing command lines or environment data.
func (m *Manager) ProcessRoots() map[string]int {
	m.mu.Lock()
	sessions := make(map[string]*Session, len(m.sessions))
	for id, s := range m.sessions {
		sessions[id] = s
	}
	m.mu.Unlock()
	out := make(map[string]int, len(sessions))
	for id, s := range sessions {
		if pid := s.PID(); pid > 0 {
			out[id] = pid
		}
	}
	return out
}

// CloseAll terminates every session (daemon shutdown).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	for _, id := range ids {
		m.stopStatusWatcher(id)
	}
	for _, s := range all {
		_ = s.Close()
	}
}

// ProcStat is a live session's resource usage, surfaced in nodeInfo.
type ProcStat struct {
	PID      int     `json:"pid"`
	RSSBytes uint64  `json:"rssBytes"`
	CPUPct   float64 `json:"cpuPct"`
}

// procSample is the previous CPU reading for a session (to derive a delta %).
type procSample struct{ proc, total uint64 }

// ProcessStats returns each live session's resident memory + CPU% (the delta
// since the previous call, as a share of total host CPU) for per-session resource
// attribution in nodeInfo. Sessions with no live process are omitted. /proc reads
// happen OUTSIDE m.mu (PID() locks per-session) so a slow read can't stall the
// registry; the CPU sample state is guarded by its own procMu.
func (m *Manager) ProcessStats() map[string]ProcStat {
	m.mu.Lock()
	snap := make(map[string]*Session, len(m.sessions))
	for id, s := range m.sessions {
		snap[id] = s
	}
	m.mu.Unlock()

	total := metrics.TotalCPUJiffies()
	out := make(map[string]ProcStat, len(snap))
	next := make(map[string]procSample, len(snap))
	m.procMu.Lock()
	for id, s := range snap {
		pid := s.PID()
		if pid <= 0 {
			continue
		}
		proc := metrics.ProcCPUJiffies(pid)
		var cpu float64
		if last, ok := m.procSamples[id]; ok && total > last.total {
			cpu = 100 * float64(proc-last.proc) / float64(total-last.total)
			if cpu < 0 {
				cpu = 0
			}
		}
		next[id] = procSample{proc: proc, total: total}
		out[id] = ProcStat{PID: pid, RSSBytes: metrics.ProcRSSBytes(pid), CPUPct: math.Round(cpu*10) / 10}
	}
	m.procSamples = next
	m.procMu.Unlock()
	return out
}

// DroppedOutputBytes returns a bounded diagnostic counter without exposing output.
func (m *Manager) DroppedOutputBytes() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	var total uint64
	for _, s := range m.sessions {
		total += s.DroppedOutputBytes()
	}
	return total
}

// Shutdown gracefully stops every session for daemon teardown: SIGTERM each (so
// agents can flush transcripts/state), wait up to grace for them to exit, then
// CloseAll() force-kills + clears any stragglers. Replaces a blunt CloseAll on
// SIGTERM so a clean node shutdown doesn't SIGKILL every agent mid-write.
func (m *Manager) Shutdown(grace time.Duration) {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()

	for _, s := range all {
		s.Terminate()
	}
	done := make(chan struct{})
	go func() {
		for _, s := range all {
			<-s.Done()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
	}
	m.CloseAll() // reap any stragglers (SIGKILL), clear registry, stop watchers
}
