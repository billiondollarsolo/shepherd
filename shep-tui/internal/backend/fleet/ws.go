package fleet

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// StatusChannel is the live status fan-out channel name (spec §8.2).
const StatusChannel = "status"

// HTTPBaseToWS converts an HTTP(S) base URL to a WebSocket base (scheme only).
// Trailing slashes are stripped. Returns an error if the scheme is not http(s)/ws(s).
func HTTPBaseToWS(httpBase string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(httpBase), "/")
	if base == "" {
		return "", fmt.Errorf("empty base URL")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse base URL: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// already WS
	default:
		return "", fmt.Errorf("unsupported scheme %q (want http/https)", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("base URL missing host")
	}
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

// StatusWebSocketURL builds ws(s)://host/ws/status from an HTTP base URL.
func StatusWebSocketURL(httpBase string) (string, error) {
	wsBase, err := HTTPBaseToWS(httpBase)
	if err != nil {
		return "", err
	}
	return wsBase + "/ws/" + StatusChannel, nil
}

// PtyWebSocketURL builds ws(s)://host/ws/pty/{sessionId} with optional ?cols=&rows=.
// sessionId is path-escaped. Size query is omitted when cols or rows is 0.
func PtyWebSocketURL(httpBase, sessionID string, cols, rows uint16) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("empty session id")
	}
	wsBase, err := HTTPBaseToWS(httpBase)
	if err != nil {
		return "", err
	}
	path := wsBase + "/ws/pty/" + url.PathEscape(sessionID)
	if cols > 0 && rows > 0 {
		q := url.Values{}
		q.Set("cols", strconv.FormatUint(uint64(cols), 10))
		q.Set("rows", strconv.FormatUint(uint64(rows), 10))
		path += "?" + q.Encode()
	}
	return path, nil
}

// EncodeStatusSubscribe returns the client→server subscribe envelope for status.
func EncodeStatusSubscribe() string {
	return `{"op":"subscribe","channel":"status"}`
}

// EncodePtyResize returns the ClientPtyResizeMessage TEXT frame the bridge expects.
func EncodePtyResize(sessionID string, cols, rows uint16) string {
	b, err := json.Marshal(struct {
		Op        string `json:"op"`
		SessionID string `json:"sessionId"`
		Cols      uint16 `json:"cols"`
		Rows      uint16 `json:"rows"`
	}{
		Op:        "pty:resize",
		SessionID: sessionID,
		Cols:      cols,
		Rows:      rows,
	})
	if err != nil {
		return `{"op":"pty:resize","sessionId":"","cols":0,"rows":0}`
	}
	return string(b)
}

// wireStatusFrame is the JSON shape of StatusUpdateMessage (shared contracts).
type wireStatusFrame struct {
	Channel   string         `json:"channel"`
	SessionID string         `json:"sessionId"`
	Status    string         `json:"status"`
	Detail    *string        `json:"detail"`
	TS        string         `json:"ts"`
	Meta      *wireTelemetry `json:"meta"`
}

type wireTelemetry struct {
	Tokens        *int     `json:"tokens"`
	Tool          *string  `json:"tool"`
	Model         *string  `json:"model"`
	ContextTokens *int     `json:"contextTokens"`
	ContextLimit  *int     `json:"contextLimit"`
	CostUSD       *float64 `json:"costUsd"`
}

// ParseStatusFrame validates an inbound status-channel JSON frame and maps it
// to backend.StatusUpdate. Returns ok=false for non-status or malformed frames.
func ParseStatusFrame(data []byte) (backend.StatusUpdate, bool) {
	var f wireStatusFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return backend.StatusUpdate{}, false
	}
	// Accept missing channel only when sessionId+status present? Web zod requires
	// channel=="status". Reject empty channel and non-status.
	if f.Channel != StatusChannel || f.SessionID == "" || f.Status == "" {
		return backend.StatusUpdate{}, false
	}
	u := backend.StatusUpdate{
		SessionID: f.SessionID,
		Status:    domain.ParseStatus(f.Status),
	}
	if f.Meta != nil {
		u.Telemetry = metaToTelemetry(f.Meta)
	}
	return u, true
}

// parseStatusFrame is the unexported alias used by the status read loop.
func parseStatusFrame(data []byte) (backend.StatusUpdate, bool) {
	return ParseStatusFrame(data)
}

func metaToTelemetry(m *wireTelemetry) domain.Telemetry {
	var t domain.Telemetry
	if m.Model != nil {
		t.Model = *m.Model
	}
	if m.Tool != nil {
		t.Tool = *m.Tool
	}
	if m.Tokens != nil {
		t.Tokens = *m.Tokens
	}
	if m.ContextTokens != nil {
		t.ContextTokens = *m.ContextTokens
	}
	if m.ContextLimit != nil {
		t.ContextLimit = *m.ContextLimit
	}
	if m.CostUSD != nil {
		v := *m.CostUSD
		t.CostUSD = &v
	}
	return t
}

// cookieURLForWS returns the http(s) URL used to look up cookies for a ws(s) URL.
func cookieURLForWS(wsURL string) (*url.URL, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(u.Scheme) {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return nil, fmt.Errorf("unsupported ws scheme %q", u.Scheme)
	}
	u.Path = "/"
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}
