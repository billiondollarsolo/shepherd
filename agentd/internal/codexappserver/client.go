package codexappserver

import (
	"context"
	"encoding/json"
)

// client.go — the small typed layer over Conn: the exact request/response shapes
// for the handshake + turn lifecycle we drive (read from the version-exact JSON
// Schema under codex-schema/v2). Everything else on the wire arrives as
// notifications (OnNotification → codexItemToEvents) or server-requests (approvals).

// Initialize performs the app-server handshake. No auth is required — initialize
// (and the whole protocol) works unauthenticated; only model/list needs auth to
// return a non-empty list. Params: {clientInfo:{name,version}} (InitializeParams).
func (c *Conn) Initialize(ctx context.Context) error {
	_, err := c.Call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "flock-agentd",
			"version": "1",
		},
	})
	return err
}

// threadStartResult is the tolerant shape of a thread/start response: only the
// nested thread.id is needed (ThreadStartResponse.thread → Thread.id).
type threadStartResult struct {
	Thread struct {
		ID string `json:"id"`
	} `json:"thread"`
}

// ThreadStart opens a conversation thread and returns its id (threadId), which every
// subsequent turn/start references. cwd is passed through (optional override).
func (c *Conn) ThreadStart(ctx context.Context, cwd string) (string, error) {
	params := map[string]any{}
	if cwd != "" {
		params["cwd"] = cwd
	}
	raw, err := c.Call(ctx, "thread/start", params)
	if err != nil {
		return "", err
	}
	var res threadStartResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", err
	}
	return res.Thread.ID, nil
}

// TurnStart submits one user turn (TurnStartParams: {threadId, input:[{type:"text",
// text}]}). The turn's assistant reply, tool calls, and reasoning stream back as
// item/* notifications, ending with turn/completed — so callers rely on those events
// for status, not on this response. Returns when the server acknowledges the turn.
func (c *Conn) TurnStart(ctx context.Context, threadID, text string) error {
	_, err := c.Call(ctx, "turn/start", map[string]any{
		"threadId": threadID,
		"input": []map[string]any{
			{"type": "text", "text": text},
		},
	})
	return err
}

// modelListResult is the tolerant shape of a model/list response
// (ModelListResponse.data → []Model). Only id/model/displayName are read.
type modelListResult struct {
	Data []struct {
		ID          string `json:"id"`
		Model       string `json:"model"`
		DisplayName string `json:"displayName"`
	} `json:"data"`
}

// ModelList returns the DYNAMIC model ids advertised by the tool (the headline win:
// no static catalog). Prefers the stable `id`, falling back to `model`. Returns an
// EMPTY slice (no error) when the list is empty — codex returns no models until it is
// authenticated, and the caller must degrade gracefully rather than fail.
func (c *Conn) ModelList(ctx context.Context) ([]string, error) {
	raw, err := c.Call(ctx, "model/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var res modelListResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(res.Data))
	seen := make(map[string]struct{}, len(res.Data))
	for _, m := range res.Data {
		id := m.ID
		if id == "" {
			id = m.Model
		}
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}
