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
// Terminal mode only. Screen is a first-class source: we do NOT feed the last
// wire status back as a fake Transcript (that sticky-locked awaiting_input after
// a screen raise and blocked idle clear).
//
// Emit whenever screen authority produces a new wire state. Screen owns
// transitions between blocked/working/idle for agents without active lifecycle
// authority (hooks still emit through their own path and can reassert).
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
		// Screen-only merge: no fake Transcript from last wire status.
		// Current is only used as hold when screen cannot classify (unknown).
		dec := authority.Merge(authority.Input{
			Mode:           authority.ModeTerminal,
			Current:        "", // do not hold previous screen raise as truth
			ScreenDetectOn: true,
			Screen: authority.Source{
				State:           r.State,
				VisibleBlocker:  r.VisibleBlocker,
				VisibleWorking:  r.VisibleWorking,
				SkipStateUpdate: r.SkipStateUpdate,
				FromScreen:      true,
			},
		})
		// Prefer explicit screen map when Merge yields default/current hold.
		wire := dec.State
		if dec.Source != "screen" {
			if w := screendetect.MapToWire(r.State); w != "" {
				wire = w
				dec.Source = "screen"
			}
		}
		if wire == "" || wire == lastWire {
			continue
		}
		// Screen path may raise and clear Needs-you (blocked→idle/working).
		if dec.Source == "screen" || lastWire == "" {
			lastWire = wire
			m.emitStatus(StatusEvent{ID: id, Update: status.Update{State: wire}})
		}
	}
}
