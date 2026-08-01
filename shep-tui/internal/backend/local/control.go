package local

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/billiondollarsolo/flock/agentd/proto"
	"github.com/billiondollarsolo/shep-tui/internal/backend"
)

// Ensure Client implements AgentController.
var _ backend.AgentController = (*Client)(nil)

// HasAgentControl reports whether agent_control_v1 is advertised (server-side
// wait/prompt). Caps.AgentControl may also be true when only screendetect_v1 is
// present; explain still works via SessionExplain without this gate.
func (c *Client) HasAgentControl() bool {
	return c.HasCapability("agent_control_v1")
}

// SessionPrompt implements backend.AgentController via agentd session.prompt.
func (c *Client) SessionPrompt(ctx context.Context, sessionID, text string) error {
	if sessionID == "" {
		return fmt.Errorf("session prompt: empty session id")
	}
	if !c.HasCapability("agent_control_v1") {
		// Fallback: raw PTY write of text + CR
		return c.writePty(sessionID, []byte(text+"\r"))
	}
	ctrl, err := c.requestControl(ctx, proto.Control{
		Op:   "session.prompt",
		ID:   sessionID,
		Text: text,
	}, func(x proto.Control) bool {
		return (x.Op == "session.promptOk" || x.Op == "error") && (x.ID == sessionID || x.Op == "error")
	})
	if err != nil {
		return fmt.Errorf("session prompt: %w", err)
	}
	if ctrl.Op == "error" {
		return fmt.Errorf("session prompt: %s", ctrl.Message)
	}
	return nil
}

// SessionExplain implements backend.AgentController via agentd statusExplain.
func (c *Client) SessionExplain(ctx context.Context, sessionID string) (map[string]any, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("session explain: empty session id")
	}
	ctrl, err := c.requestControl(ctx, proto.Control{
		Op: "statusExplain",
		ID: sessionID,
	}, func(x proto.Control) bool {
		return (x.Op == "statusExplain" || x.Op == "error") && (x.ID == sessionID || x.Op == "error")
	})
	if err != nil {
		return nil, fmt.Errorf("session explain: %w", err)
	}
	if ctrl.Op == "error" {
		return nil, fmt.Errorf("session explain: %s", ctrl.Message)
	}
	out := map[string]any{
		"state":       ctrl.State,
		"matchedRule": ctrl.MatchedRule,
		"sessionId":   sessionID,
	}
	if len(ctrl.Explain) > 0 {
		var explained map[string]any
		if json.Unmarshal(ctrl.Explain, &explained) == nil {
			for k, v := range explained {
				out[k] = v
			}
		} else {
			out["explainRaw"] = string(ctrl.Explain)
		}
	}
	return out, nil
}

// SessionWaitStatus implements backend.AgentController via agentd session.wait_status.
func (c *Client) SessionWaitStatus(ctx context.Context, sessionID string, until []string, timeout time.Duration) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("session wait: empty session id")
	}
	if !c.HasCapability("agent_control_v1") {
		return "", backend.ErrNotSupported
	}
	if len(until) == 0 {
		until = []string{"idle", "done", "awaiting_input"}
	}
	timeoutMs := int(timeout / time.Millisecond)
	if timeoutMs <= 0 {
		timeoutMs = 30_000
	}
	// requestControl deadline must exceed server wait
	reqCtx := ctx
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, timeout+5*time.Second)
		defer cancel()
	}
	ctrl, err := c.requestControl(reqCtx, proto.Control{
		Op:        "session.wait_status",
		ID:        sessionID,
		Until:     until,
		TimeoutMS: timeoutMs,
	}, func(x proto.Control) bool {
		return (x.Op == "session.waitStatus" || x.Op == "error") && (x.ID == sessionID || x.Op == "error" || strings.Contains(x.Message, "timeout"))
	})
	if err != nil {
		return "", fmt.Errorf("session wait: %w", err)
	}
	if ctrl.Op == "error" {
		return "", fmt.Errorf("session wait: %s", ctrl.Message)
	}
	return ctrl.State, nil
}
