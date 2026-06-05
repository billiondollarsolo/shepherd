package session

import (
	"context"
	"time"

	"flock-agentd/internal/status"
)

// StatusEvent is a derived agent status update for one session, fanned out to
// connected orchestrators (which feed it into the live status map + meta). It is
// a session id plus the full telemetry snapshot — embedding status.Update means a
// new telemetry field added to Update flows through here automatically (no copy).
// Internal only (never JSON-marshaled); converted to proto.Control on the wire.
type StatusEvent struct {
	ID string
	status.Update
}

// StatusSub is a live status stream plus the current snapshot to replay first.
type StatusSub struct {
	// Snapshot is the current status of every session at subscribe time.
	Snapshot []StatusEvent
	// Events streams subsequent changes; closed on Close.
	Events <-chan StatusEvent
	close  func()
}

// Close unsubscribes (idempotent).
func (s *StatusSub) Close() { s.close() }

// SubscribeStatus returns the current per-session status snapshot plus a live
// channel of subsequent changes. A reconnecting orchestrator gets the snapshot
// so its dots are correct immediately.
func (m *Manager) SubscribeStatus() *StatusSub {
	m.statusMu.Lock()
	defer m.statusMu.Unlock()
	snap := make([]StatusEvent, 0, len(m.lastStatus))
	for _, ev := range m.lastStatus {
		snap = append(snap, ev)
	}
	ch := make(chan StatusEvent, 64)
	id := m.statusNext
	m.statusNext++
	m.statusSubs[id] = ch
	return &StatusSub{
		Snapshot: snap,
		Events:   ch,
		close: func() {
			m.statusMu.Lock()
			if c, ok := m.statusSubs[id]; ok {
				delete(m.statusSubs, id)
				close(c)
			}
			m.statusMu.Unlock()
		},
	}
}

// emitStatus records the latest status for a session and fans it out. A slow
// subscriber drops the event (status is last-write-wins; the snapshot on the
// next subscribe corrects any miss) rather than blocking the watcher.
func (m *Manager) emitStatus(ev StatusEvent) {
	m.statusMu.Lock()
	m.lastStatus[ev.ID] = ev
	subs := make([]chan StatusEvent, 0, len(m.statusSubs))
	for _, ch := range m.statusSubs {
		subs = append(subs, ch)
	}
	m.statusMu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// startStatusWatcher derives live status for a session: by tailing the agent's
// transcript (claude/codex) when one exists, else — when spec.ActivityStatus is
// set (e.g. gemini) — by PTY OUTPUT ACTIVITY. No-op for plain shells/unknown with
// neither source. Stopped via stopStatusWatcher (statusStops[id]).
func (m *Manager) startStatusWatcher(spec Spec, s *Session) {
	agent := status.DetectAgent(spec.Command)
	if agent == "" && !spec.ActivityStatus {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.statusMu.Lock()
	if old := m.statusStops[spec.ID]; old != nil {
		old()
	}
	m.statusStops[spec.ID] = cancel
	m.statusMu.Unlock()

	id := spec.ID
	if agent == "" {
		// Activity-based status (T61): no transcript to tail.
		go m.watchActivity(ctx, id, s)
		return
	}

	startedAt := time.Now()
	claim := func(path string) bool { return m.claimFile(path, id) }
	// Pass the session's scoped agent-config dir so the transcript tailer follows
	// claude/codex's transcript into the Flock-seeded CLAUDE_CONFIG_DIR / CODEX_HOME
	// (where they actually write it) instead of the default ~/.claude · ~/.codex.
	go status.Watch(ctx, agent, spec.Cwd, s.configDir, startedAt, claim, func(u status.Update) {
		m.emitStatus(StatusEvent{ID: id, Update: u})
	})
}

// watchActivity derives running/idle from PTY output gaps for agents with no
// transcript/hook (T61, e.g. gemini). Recent output (< activeWindow) → running;
// a longer quiet gap → idle (turn complete / waiting for you). It cannot tell
// idle from awaiting_input — that needs a real signal the agent doesn't give us.
//
// activeWindow is the SUSTAINED-QUIET threshold before we call it idle. It must be
// generous: a 3s window flapped running⇄idle on every brief thinking/streaming
// pause within a single turn (visible as a ping-pong status timeline). 10s means
// "idle" reflects a real lull, not a mid-turn pause — the dot stays steady.
func (m *Manager) watchActivity(ctx context.Context, id string, s *Session) {
	const (
		poll         = 700 * time.Millisecond
		activeWindow = 10 * time.Second
	)
	// Reuse the transcript watchers' Emitter (same dedup primitive): only a state
	// change is forwarded. It emits the full snapshot, but only State is ever set
	// here, so downstream sees a plain running/idle transition.
	e := status.NewEmitter(func(u status.Update) { m.emitStatus(StatusEvent{ID: id, Update: u}) })
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(poll):
		}
		last := s.LastActivity()
		if last.IsZero() {
			continue // no output yet → leave the orchestrator's initial state
		}
		if time.Since(last) < activeWindow {
			e.Push(status.Update{State: status.StateRunning})
		} else {
			e.Push(status.Update{State: status.StateIdle})
		}
	}
}

// claimFile reserves a transcript path for a session so two sessions in the same
// cwd don't tail the same file. Returns true if the caller owns it.
func (m *Manager) claimFile(path, sessionID string) bool {
	m.statusMu.Lock()
	defer m.statusMu.Unlock()
	if owner, taken := m.claimedFiles[path]; taken && owner != sessionID {
		return false
	}
	m.claimedFiles[path] = sessionID
	return true
}

// releaseClaims drops any transcript claims held by a session (on close).
func (m *Manager) releaseClaims(sessionID string) {
	m.statusMu.Lock()
	defer m.statusMu.Unlock()
	for p, owner := range m.claimedFiles {
		if owner == sessionID {
			delete(m.claimedFiles, p)
		}
	}
}

// stopStatusWatcher cancels a session's watcher, drops its last status, and
// releases any transcript it had claimed.
func (m *Manager) stopStatusWatcher(id string) {
	m.statusMu.Lock()
	cancel := m.statusStops[id]
	delete(m.statusStops, id)
	delete(m.lastStatus, id)
	m.statusMu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.releaseClaims(id)
}
