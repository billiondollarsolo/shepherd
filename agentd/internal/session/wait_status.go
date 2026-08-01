package session

import (
	"context"
	"fmt"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/agentcontrol"
)

// WaitStatusError is returned when a wait cannot complete successfully.
type WaitStatusError struct {
	Code    string
	Message string
}

func (e *WaitStatusError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// WaitStatus blocks until the session's status is in until, the timeout fires,
// the session closes, or the occupant (PID) is replaced (H2.1).
// timeoutMs <= 0 means wait indefinitely (capped at 10 minutes by callers).
func (m *Manager) WaitStatus(ctx context.Context, id string, until []string, timeoutMs int) (state string, err error) {
	sess := m.Get(id)
	if sess == nil {
		return "", &WaitStatusError{Code: "no_such_session", Message: "no such session"}
	}
	pinPID := sess.PID()

	// Immediate match on current status.
	if st := m.currentState(id); agentcontrol.WaitMatch(st, until) {
		return st, nil
	}

	sub := m.SubscribeStatus()
	defer sub.Close()

	var timer <-chan time.Time
	if timeoutMs > 0 {
		t := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
		defer t.Stop()
		timer = t.C
	}

	// Re-check after subscribe (race with concurrent update).
	if st := m.currentState(id); agentcontrol.WaitMatch(st, until) {
		return st, nil
	}

	for {
		select {
		case <-ctx.Done():
			return "", &WaitStatusError{Code: "canceled", Message: ctx.Err().Error()}
		case <-timer:
			return "", &WaitStatusError{Code: "timeout", Message: "wait_status timed out"}
		case <-sess.Done():
			// Process ended — final status may be done/error.
			st := m.currentState(id)
			if st == "" {
				st = "done"
			}
			if agentcontrol.WaitMatch(st, until) {
				return st, nil
			}
			return st, &WaitStatusError{Code: "session_ended", Message: "session ended before match"}
		case ev, ok := <-sub.Events:
			if !ok {
				return "", &WaitStatusError{Code: "unsubscribed", Message: "status subscription closed"}
			}
			// Occupant pin: if the session object is replaced or PID changes, fail.
			cur := m.Get(id)
			if cur == nil {
				return "", &WaitStatusError{Code: "agent_not_running", Message: "session gone"}
			}
			if pinPID != 0 {
				curPID := cur.PID()
				if curPID != 0 && curPID != pinPID {
					return "", &WaitStatusError{Code: "occupant_replaced", Message: "session process was replaced"}
				}
			}
			if ev.ID != id {
				continue
			}
			st := ev.State
			if st == "" {
				st = m.currentState(id)
			}
			if agentcontrol.WaitMatch(st, until) {
				return st, nil
			}
		}
	}
}

func (m *Manager) currentState(id string) string {
	m.statusMu.Lock()
	defer m.statusMu.Unlock()
	ev, ok := m.lastStatus[id]
	if !ok {
		return ""
	}
	return ev.State
}

// CurrentStatus returns the last known wire status for a session (may be empty).
func (m *Manager) CurrentStatus(id string) string {
	return m.currentState(id)
}

// FormatWaitError code helper for control responses.
func FormatWaitError(err error) (code, message string) {
	if e, ok := err.(*WaitStatusError); ok {
		return e.Code, e.Message
	}
	return "wait_failed", fmt.Sprint(err)
}
