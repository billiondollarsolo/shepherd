package acp

import (
	"context"
	"encoding/json"
)

// LaunchCommand returns the argv to start an agent in ACP (structured) mode, and
// whether the agent supports ACP at all.
//
//	gemini → gemini --experimental-acp  (answers ACP initialize; VERIFIED)
//	cursor → cursor-agent acp
//
// Grok is intentionally NOT listed: `grok agent stdio` is a JSON line protocol
// that ignores ACP's initialize handshake (verified 2026-06-08). Grok runs as a
// native PTY with status from Claude-compatible hooks. Agents not listed here
// use the raw-PTY transport (the universal fallback, Invariant 1).
func LaunchCommand(agentType string) ([]string, bool) {
	switch agentType {
	case "gemini":
		return []string{"gemini", "--experimental-acp"}, true
	case "cursor":
		return []string{"cursor-agent", "acp"}, true
	default:
		return nil, false
	}
}

// SupportsACP reports whether an agent type can run over the structured transport.
func SupportsACP(agentType string) bool {
	_, ok := LaunchCommand(agentType)
	return ok
}

// Initialize performs the ACP handshake. Must be called before NewSession.
func (c *Conn) Initialize(ctx context.Context) error {
	_, err := c.Call(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}},
	})
	return err
}

// NewSession opens a session rooted at cwd (with optional MCP servers the agent
// should connect to) and returns its ACP session id.
func (c *Conn) NewSession(ctx context.Context, cwd string, mcpServers []any) (string, error) {
	if mcpServers == nil {
		mcpServers = []any{}
	}
	res, err := c.Call(ctx, "session/new", map[string]any{"cwd": cwd, "mcpServers": mcpServers})
	if err != nil {
		return "", err
	}
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

// Prompt sends a user turn. The agent streams its work back as session/update
// notifications (delivered to Handlers.OnUpdate) and resolves the Call when the
// turn ends.
func (c *Conn) Prompt(ctx context.Context, sessionID, text string) error {
	_, err := c.Call(ctx, "session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []map[string]any{{"type": "text", "text": text}},
	})
	return err
}

// Cancel aborts the current turn for a session (notification, no response).
func (c *Conn) Cancel(sessionID string) error {
	return c.Notify("session/cancel", map[string]any{"sessionId": sessionID})
}
