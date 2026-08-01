// Package domain holds Flock-aligned types shared by UI and backends.
// Status vocabulary must stay in lockstep with flock/packages/shared/src/status.ts.
package domain

// Status is the unified agent session status (Flock StatusEnum).
type Status string

const (
	StatusStarting      Status = "starting"
	StatusRunning       Status = "running"
	StatusAwaitingInput Status = "awaiting_input"
	StatusIdle          Status = "idle"
	StatusDone          Status = "done"
	StatusError         Status = "error"
	StatusDisconnected  Status = "disconnected"
)

// StatusValues is every valid Status, for tests and exhaustive UI.
var StatusValues = []Status{
	StatusStarting,
	StatusRunning,
	StatusAwaitingInput,
	StatusIdle,
	StatusDone,
	StatusError,
	StatusDisconnected,
}

// Affirmative display labels — never blank Idle, never "running" in UI copy.
var statusLabel = map[Status]string{
	StatusStarting:      "Starting",
	StatusRunning:       "Working",
	StatusAwaitingInput: "Needs you",
	StatusIdle:          "Idle",
	StatusDone:          "Done",
	StatusError:         "Error",
	StatusDisconnected:  "Disconnected",
}

// Label returns the human-facing affirmative word for s.
func (s Status) Label() string {
	if l, ok := statusLabel[s]; ok {
		return l
	}
	if s == "" {
		return "Idle"
	}
	return string(s)
}

// StatusPolicy is UX policy per status (mirrors STATUS_POLICY in shared).
type StatusPolicy struct {
	RingsSidebar  bool
	Pushes        bool
	AttentionRank int // lower sorts higher in "needs attention"
}

var statusPolicy = map[Status]StatusPolicy{
	StatusStarting:      {RingsSidebar: false, Pushes: false, AttentionRank: 4},
	StatusRunning:       {RingsSidebar: false, Pushes: false, AttentionRank: 5},
	StatusAwaitingInput: {RingsSidebar: true, Pushes: true, AttentionRank: 0},
	StatusIdle:          {RingsSidebar: false, Pushes: false, AttentionRank: 3},
	StatusDone:          {RingsSidebar: false, Pushes: true, AttentionRank: 2},
	StatusError:         {RingsSidebar: true, Pushes: true, AttentionRank: 1},
	StatusDisconnected:  {RingsSidebar: false, Pushes: false, AttentionRank: 6},
}

// Policy returns UX policy for s (unknown → disconnected-like quiet).
func (s Status) Policy() StatusPolicy {
	if p, ok := statusPolicy[s]; ok {
		return p
	}
	return statusPolicy[StatusDisconnected]
}

// ParseStatus maps a wire string to Status; unknown values pass through as Status(s).
func ParseStatus(s string) Status {
	st := Status(s)
	if _, ok := statusLabel[st]; ok {
		return st
	}
	return st
}
