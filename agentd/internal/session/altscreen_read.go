package session

import (
	"errors"

	"github.com/billiondollarsolo/flock/agentd/internal/screendetect"
)

// ErrAltScreenReadNotIdle is returned when intelligent alt-screen capture is
// requested while the agent is not idle (H4.3 / Herdr agent_not_idle).
var ErrAltScreenReadNotIdle = errors.New("agent_not_idle")

// ReadRecentScreen returns detection/visible text. When altScreen and idle,
// returns the current alt-screen buffer (paging wheel capture is feature-flagged
// off by default — FLOCK_ALT_SCREEN_READ=1 reserved for future mouse paging).
func (s *Session) ReadRecentScreen(wireStatus string) (text string, alt bool, err error) {
	snap := s.ScreenSnapshot()
	alt = snap.AltScreen
	if alt {
		// Refuse aggressive history walks while working/blocked.
		st := wireStatus
		if st == "" {
			// fall back to screen classification
			agent := DetectScreenAgent(s.SpecValue().Command)
			if agent != "" {
				if e := screenEngine(); e != nil {
					r := e.Detect(screendetect.Input{Agent: agent, Screen: snap.Text, OSCTitle: snap.OSCTitle})
					st = screendetect.MapToWire(r.State)
				}
			}
		}
		if st == "running" || st == "awaiting_input" {
			return snap.Text, true, ErrAltScreenReadNotIdle
		}
	}
	if snap.Text != "" {
		return snap.Text, alt, nil
	}
	return string(s.ScrollbackBytes()), alt, nil
}
