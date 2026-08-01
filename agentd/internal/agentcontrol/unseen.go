package agentcontrol

// NextUnseenIdle implements D9: turn-complete idle while unfocused → unseenIdle;
// focus/input or session end clears it. Wire status stays idle (not done).
func NextUnseenIdle(prevStatus, nextStatus string, focused, prevUnseen bool) bool {
	switch nextStatus {
	case "done", "error", "disconnected":
		return false
	}
	if focused {
		return false
	}
	if nextStatus == "idle" {
		return true
	}
	if prevUnseen && nextStatus == "idle" {
		return true
	}
	return false
}
