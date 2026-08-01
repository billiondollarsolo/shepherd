package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/authority"
	"github.com/billiondollarsolo/flock/agentd/internal/screendetect"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// Shared screendetect engine (bundled manifests). Initialized lazily.
var (
	globalScreenEngine     *screendetect.Engine
	globalScreenEngineOnce sync.Once
)

func screenEngine() *screendetect.Engine {
	globalScreenEngineOnce.Do(func() {
		override := os.Getenv("FLOCK_AGENT_DETECTION_DIR")
		e, err := screendetect.NewEngine(override)
		if err != nil {
			e, _ = screendetect.NewEngine("")
		}
		globalScreenEngine = e
	})
	return globalScreenEngine
}

// ReloadScreenManifests reloads override + bundled manifests (H4.1).
func ReloadScreenManifests() error {
	e := screenEngine()
	if e == nil {
		return nil
	}
	return e.Reload()
}

// ScreenDetectEnabled is D10: default off unless FLOCK_SCREENDETECT is truthy.
func ScreenDetectEnabled() bool {
	return screendetect.EnabledFromEnv(os.Getenv("FLOCK_SCREENDETECT"))
}

// DetectScreenAgent maps command argv to a screendetect manifest id.
func DetectScreenAgent(command []string) string {
	if len(command) == 0 {
		return ""
	}
	// Prefer transcript DetectAgent ids that match manifests; else basename map.
	if a := status.DetectAgent(command); a != "" {
		if a == "antigravity" {
			return "agy"
		}
		return a
	}
	joined := strings.Join(command, " ")
	for _, name := range []string{
		"claude", "codex", "opencode", "grok", "agy", "cursor-agent", "cursor", "amp",
	} {
		base := name
		if name == "cursor-agent" {
			base = "cursor"
		}
		if strings.Contains(joined, name) {
			if name == "cursor-agent" || name == "cursor" {
				return "cursor"
			}
			return base
		}
	}
	base := filepath.Base(command[0])
	switch base {
	case "cursor-agent":
		return "cursor"
	case "agy":
		return "agy"
	default:
		return base
	}
}

// ExplainScreen runs screendetect explain for a live session (H1.4).
func (s *Session) ExplainScreen() screendetect.Explain {
	agent := DetectScreenAgent(s.SpecValue().Command)
	snap := s.ScreenSnapshot()
	e := screenEngine()
	if e == nil || agent == "" {
		return screendetect.Explain{Agent: agent, State: screendetect.StateUnknown, FallbackReason: "no_engine_or_agent"}
	}
	return e.Explain(screendetect.Input{
		Agent:    agent,
		Screen:   snap.Text,
		OSCTitle: snap.OSCTitle,
	})
}

// ClassifyScreen returns wire status from screen detection alone (for tests).
func ClassifyScreen(agent, screenText, oscTitle string) (wireState string, result screendetect.Result) {
	e := screenEngine()
	if e == nil {
		return "", screendetect.Result{State: screendetect.StateUnknown}
	}
	r := e.Detect(screendetect.Input{Agent: agent, Screen: screenText, OSCTitle: oscTitle})
	return screendetect.MapToWire(r.State), r
}

// watchScreenDetect polls the screen model and emits status when enabled (H1.3).
// In Chat mode sessions this is never started. Terminal mode uses authority merge
// so screen can supply awaiting_input when transcripts miss blockers.
func (m *Manager) watchScreenDetect(ctx context.Context, id string, s *Session) {
	if !ScreenDetectEnabled() {
		return
	}
	if authority.IsChatMode(s.SpecValue().Mode) {
		return
	}
	agent := DetectScreenAgent(s.SpecValue().Command)
	if agent == "" {
		return
	}
	e := screenEngine()
	if e == nil {
		return
	}
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	var lastWire string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		snap := s.ScreenSnapshot()
		r := e.Detect(screendetect.Input{
			Agent:    agent,
			Screen:   snap.Text,
			OSCTitle: snap.OSCTitle,
		})
		if r.SkipStateUpdate {
			continue
		}
		// Merge screen with current transcript status
		m.statusMu.Lock()
		cur := m.lastStatus[id]
		m.statusMu.Unlock()
		dec := authority.Merge(authority.Input{
			Mode:           authority.ModeTerminal,
			Current:        cur.State,
			ScreenDetectOn: true,
			Screen: authority.Source{
				State:           r.State,
				VisibleBlocker:  r.VisibleBlocker,
				VisibleWorking:  r.VisibleWorking,
				SkipStateUpdate: r.SkipStateUpdate,
				FromScreen:      true,
			},
			Transcript: authority.Source{
				State:          cur.State,
				FromTranscript: true,
			},
		})
		if dec.State == "" || dec.State == lastWire {
			continue
		}
		// Only let screen *raise* awaiting_input or fill idle/running when current empty
		if dec.Source == "screen" || cur.State == "" ||
			(dec.State == status.StateAwaiting && cur.State != status.StateAwaiting) {
			lastWire = dec.State
			m.emitStatus(StatusEvent{ID: id, Update: status.Update{State: dec.State}})
		}
	}
}
