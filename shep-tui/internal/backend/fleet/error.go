package fleet

import "fmt"

// FleetError is the orchestrator REST error envelope:
//
//	{ "error": { "code": "...", "message": "..." } }
//
// Status is the HTTP status code. Code/Message come from the JSON body when present.
type FleetError struct {
	Status  int
	Code    string
	Message string
}

func (e *FleetError) Error() string {
	if e == nil {
		return "fleet: <nil error>"
	}
	if e.Code != "" && e.Message != "" {
		return fmt.Sprintf("fleet: HTTP %d %s: %s", e.Status, e.Code, e.Message)
	}
	if e.Message != "" {
		return fmt.Sprintf("fleet: HTTP %d: %s", e.Status, e.Message)
	}
	if e.Code != "" {
		return fmt.Sprintf("fleet: HTTP %d %s", e.Status, e.Code)
	}
	return fmt.Sprintf("fleet: HTTP %d", e.Status)
}
