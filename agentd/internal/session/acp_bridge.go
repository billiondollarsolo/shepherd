package session

import (
	"encoding/json"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// acp_bridge wires the ACP structured transport (internal/acp, roadmap F6) into
// agentd's existing status pipeline: ACP runtime events become `status.Update`
// partials, fanned out to the orchestrator over the SAME `status` frames the
// PTY/transcript path uses — so no proto change is needed for status/telemetry.
// The Go mapping mirrors the shared `agentEventToStatus` (F5).

// acpEventToUpdate maps a canonical ACP event to a status.Update partial (empty
// fields = unchanged). Returns false when the event carries no status/telemetry.
// Session/turn lifecycle + approvals are driven by the runner + permission
// handler (see newACPHandlers / runACPOverConn), not by session/update events.
func acpEventToUpdate(e acp.Event) (status.Update, bool) {
	switch e.Kind {
	case acp.EventContentDelta, acp.EventToolStarted, acp.EventTurnStarted:
		u := status.Update{State: status.StateRunning}
		if e.Kind == acp.EventToolStarted && e.ToolName != "" {
			u.Tool = e.ToolName
		}
		return u, true
	case acp.EventToolUpdated:
		if e.ToolStatus == "failed" {
			return status.Update{State: status.StateError}, true
		}
		return status.Update{}, false
	case acp.EventTurnCompleted:
		return status.Update{State: status.StateIdle}, true
	case acp.EventError:
		return status.Update{State: status.StateError}, true
	case acp.EventPlanUpdated:
		if len(e.Plan) == 0 {
			return status.Update{}, false
		}
		b, err := json.Marshal(e.Plan)
		if err != nil {
			return status.Update{}, false
		}
		return status.Update{Plan: string(b)}, true
	case acp.EventUsageUpdated:
		if e.Usage == nil {
			return status.Update{}, false
		}
		u := status.Update{}
		if e.Usage.TotalTokens > 0 {
			u.Tokens = int(e.Usage.TotalTokens)
		}
		if e.Usage.Model != "" {
			u.Model = e.Usage.Model
		}
		// Context occupancy for the context-% bar ≈ the prompt the model saw.
		if e.Usage.InputTokens > 0 {
			u.ContextTokens = int(e.Usage.InputTokens)
		}
		if (u == status.Update{}) {
			return status.Update{}, false
		}
		return u, true
	default:
		return status.Update{}, false
	}
}

// newACPHandlers builds the acp.Handlers that drive a session's status from its
// ACP stream: session/update events become status.Update pushes; a permission
// request flips the session to awaiting_input (the money state) and is answered
// by `respond` (return an option id to approve, "" to deny/cancel). `respond` may
// be nil → deny by default.
func newACPHandlers(push func(status.Update), respond func(acp.PermissionRequest) string) acp.Handlers {
	return acp.Handlers{
		OnUpdate: func(e acp.Event) {
			if u, ok := acpEventToUpdate(e); ok {
				push(u)
			}
		},
		OnPermission: func(req acp.PermissionRequest) string {
			push(status.Update{State: status.StateAwaiting})
			if respond == nil {
				return ""
			}
			decision := respond(req)
			// Whatever the decision, the block is resolved → back to running.
			push(status.Update{State: status.StateRunning})
			return decision
		},
	}
}
