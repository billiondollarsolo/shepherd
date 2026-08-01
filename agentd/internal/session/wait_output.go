package session

import (
	"context"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/agentcontrol"
)

// WaitOutput polls scrollback/screen until match or timeout (H2.1 real wait).
// timeoutMs <= 0 defaults to 120s; hard cap 10 minutes.
func (m *Manager) WaitOutput(ctx context.Context, id, substr, regex string, timeoutMs int) (matchedLine string, err error) {
	sess := m.Get(id)
	if sess == nil {
		return "", &WaitStatusError{Code: "no_such_session", Message: "no such session"}
	}
	if substr == "" && regex == "" {
		return "", &WaitStatusError{Code: "bad_request", Message: "match or regex required"}
	}
	if timeoutMs <= 0 {
		timeoutMs = 120_000
	}
	if timeoutMs > 600_000 {
		timeoutMs = 600_000
	}

	// Immediate match (output already present)
	if line, ok := matchSessionOutput(sess, substr, regex); ok {
		return line, nil
	}

	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return "", &WaitStatusError{Code: "canceled", Message: ctx.Err().Error()}
		case <-sess.Done():
			// Final chance on remaining buffer
			if line, ok := matchSessionOutput(sess, substr, regex); ok {
				return line, nil
			}
			return "", &WaitStatusError{Code: "session_ended", Message: "session ended before match"}
		case <-ticker.C:
			if line, ok := matchSessionOutput(sess, substr, regex); ok {
				return line, nil
			}
			if time.Now().After(deadline) {
				return "", &WaitStatusError{Code: "timeout", Message: "wait_output timed out"}
			}
		}
	}
}

func matchSessionOutput(sess *Session, substr, regex string) (string, bool) {
	text := string(sess.ScrollbackBytes())
	if text == "" {
		text = sess.ScreenSnapshot().Text
	}
	return agentcontrol.OutputMatch(text, substr, regex)
}
