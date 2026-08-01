package fleet

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestHTTPBaseToWS(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in, want string
	}{
		{"http://localhost:5173", "ws://localhost:5173"},
		{"https://flock.example", "wss://flock.example"},
		{"https://flock.example/", "wss://flock.example"},
		{"http://127.0.0.1:3000/", "ws://127.0.0.1:3000"},
		{"ws://already.ws", "ws://already.ws"},
		{"wss://already.wss/", "wss://already.wss"},
	}
	for _, tc := range cases {
		got, err := HTTPBaseToWS(tc.in)
		if err != nil {
			t.Fatalf("HTTPBaseToWS(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("HTTPBaseToWS(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if _, err := HTTPBaseToWS(""); err == nil {
		t.Fatal("expected error for empty base")
	}
	if _, err := HTTPBaseToWS("ftp://x"); err == nil {
		t.Fatal("expected error for ftp")
	}
}

func TestStatusWebSocketURL(t *testing.T) {
	t.Parallel()
	got, err := StatusWebSocketURL("https://flock.example")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://flock.example/ws/status" {
		t.Fatalf("got %q", got)
	}
	got, err = StatusWebSocketURL("http://localhost:5173/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://localhost:5173/ws/status" {
		t.Fatalf("got %q", got)
	}
}

func TestPtyWebSocketURL(t *testing.T) {
	t.Parallel()
	got, err := PtyWebSocketURL("http://localhost:5173", "s1", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://localhost:5173/ws/pty/s1" {
		t.Fatalf("got %q", got)
	}

	got, err = PtyWebSocketURL("https://flock.example", "s1", 142, 48)
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://flock.example/ws/pty/s1?cols=142&rows=48" {
		t.Fatalf("got %q", got)
	}

	// path-escape session id
	got, err = PtyWebSocketURL("http://h", "a/b c", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://h/ws/pty/a%2Fb%20c" {
		t.Fatalf("got %q", got)
	}

	if _, err := PtyWebSocketURL("http://h", "", 80, 24); err == nil {
		t.Fatal("expected empty session id error")
	}
}

func TestEncodeStatusSubscribe(t *testing.T) {
	t.Parallel()
	var m map[string]any
	if err := json.Unmarshal([]byte(EncodeStatusSubscribe()), &m); err != nil {
		t.Fatal(err)
	}
	if m["op"] != "subscribe" || m["channel"] != "status" {
		t.Fatalf("unexpected: %#v", m)
	}
	if _, ok := m["sessionId"]; ok {
		t.Fatal("status subscribe must not carry sessionId")
	}
}

func TestEncodePtyResize(t *testing.T) {
	t.Parallel()
	var m map[string]any
	if err := json.Unmarshal([]byte(EncodePtyResize("sess-1", 120, 40)), &m); err != nil {
		t.Fatal(err)
	}
	if m["op"] != "pty:resize" {
		t.Fatalf("op = %v", m["op"])
	}
	if m["sessionId"] != "sess-1" {
		t.Fatalf("sessionId = %v", m["sessionId"])
	}
	// JSON numbers are float64
	if m["cols"] != float64(120) || m["rows"] != float64(40) {
		t.Fatalf("cols/rows = %v/%v", m["cols"], m["rows"])
	}
}

func TestParseStatusFrame_ValidObject(t *testing.T) {
	t.Parallel()
	const sessionID = "11111111-1111-1111-1111-111111111111"
	raw := `{
		"channel": "status",
		"sessionId": "` + sessionID + `",
		"status": "awaiting_input",
		"detail": "permission prompt",
		"ts": "2026-05-29T06:30:00.000Z"
	}`
	u, ok := ParseStatusFrame([]byte(raw))
	if !ok {
		t.Fatal("expected ok")
	}
	if u.SessionID != sessionID {
		t.Fatalf("sessionId = %q", u.SessionID)
	}
	if u.Status != domain.StatusAwaitingInput {
		t.Fatalf("status = %q", u.Status)
	}
}

func TestParseStatusFrame_WithMeta(t *testing.T) {
	t.Parallel()
	raw := `{
		"channel": "status",
		"sessionId": "22222222-2222-2222-2222-222222222222",
		"status": "running",
		"detail": null,
		"ts": "2026-05-29T06:31:00.000Z",
		"meta": {
			"model": "claude-sonnet",
			"tool": "Bash",
			"tokens": 1200,
			"contextTokens": 50000,
			"contextLimit": 200000,
			"costUsd": 0.42
		}
	}`
	u, ok := ParseStatusFrame([]byte(raw))
	if !ok {
		t.Fatal("expected ok")
	}
	if u.Status != domain.StatusRunning {
		t.Fatalf("status = %q", u.Status)
	}
	if u.Telemetry.Model != "claude-sonnet" || u.Telemetry.Tool != "Bash" {
		t.Fatalf("telemetry model/tool = %#v", u.Telemetry)
	}
	if u.Telemetry.Tokens != 1200 || u.Telemetry.ContextTokens != 50000 || u.Telemetry.ContextLimit != 200000 {
		t.Fatalf("telemetry tokens = %#v", u.Telemetry)
	}
	if u.Telemetry.CostUSD == nil || *u.Telemetry.CostUSD != 0.42 {
		t.Fatalf("cost = %v", u.Telemetry.CostUSD)
	}
}

func TestParseStatusFrame_RejectsNonStatus(t *testing.T) {
	t.Parallel()
	cases := []string{
		`not json`,
		`42`,
		`{"channel":"status"}`,
		`{"channel":"nodes","nodeId":"x","connectionStatus":"connected","lastSeenAt":null,"ts":"2026-05-29T06:32:00.000Z"}`,
		`{"channel":"status","sessionId":"","status":"running","detail":null,"ts":"t"}`,
		`{"channel":"status","sessionId":"s","status":"","detail":null,"ts":"t"}`,
	}
	for _, raw := range cases {
		if _, ok := ParseStatusFrame([]byte(raw)); ok {
			t.Errorf("ParseStatusFrame should reject %q", raw)
		}
	}
}

func TestCookieURLForWS(t *testing.T) {
	t.Parallel()
	u, err := cookieURLForWS("wss://flock.example/ws/status")
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || u.Host != "flock.example" {
		t.Fatalf("got %s", u.String())
	}
	u, err = cookieURLForWS("ws://localhost:3000/ws/pty/x")
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "http" || !strings.HasPrefix(u.Host, "localhost") {
		t.Fatalf("got %s", u.String())
	}
}
