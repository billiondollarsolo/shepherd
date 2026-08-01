package fleet

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/gorilla/websocket"
)

func TestWatchStatus_LocalServer(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	var gotCookie, gotSubscribe string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/status" {
			http.NotFound(w, r)
			return
		}
		gotCookie = r.Header.Get("Cookie")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		gotSubscribe = string(msg)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"channel":"nodes","nodeId":"n","connectionStatus":"connected","lastSeenAt":null,"ts":"t"}`))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{
			"channel":"status",
			"sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			"status":"idle",
			"detail":null,
			"ts":"2026-05-29T06:30:00.000Z",
			"meta":{"model":"m1","tokens":9}
		}`))
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.SetSessionCookie("flock_session", "test-cookie"); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	ch, err := c.WatchStatus(ctx)
	if err != nil {
		t.Fatalf("WatchStatus: %v", err)
	}

	var u backend.StatusUpdate
	select {
	case u = <-ch:
	case <-ctx.Done():
		t.Fatal("timeout waiting for status update")
	}
	if u.SessionID != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
		t.Fatalf("session = %q", u.SessionID)
	}
	if u.Status != domain.StatusIdle {
		t.Fatalf("status = %q", u.Status)
	}
	if u.Telemetry.Model != "m1" || u.Telemetry.Tokens != 9 {
		t.Fatalf("telemetry = %#v", u.Telemetry)
	}
	cancel()
	for range ch {
	}

	if !strings.Contains(gotCookie, "flock_session=test-cookie") {
		t.Fatalf("expected cookie on upgrade, got %q", gotCookie)
	}
	if gotSubscribe != EncodeStatusSubscribe() {
		t.Fatalf("subscribe = %q", gotSubscribe)
	}
}

func TestOpenPty_LocalServer(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	var gotPath, gotQuery string
	var gotResize string
	var gotInput []byte
	done := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("hello-from-pty"))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"channel":"pty","sessionId":"s1","op":"attached"}`))

		for i := 0; i < 2; i++ {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if mt == websocket.BinaryMessage {
				gotInput = append([]byte(nil), data...)
			} else if mt == websocket.TextMessage {
				gotResize = string(data)
			}
		}
		close(done)
	}))
	defer srv.Close()

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	stream, err := c.OpenPty(ctx, "sess-xyz", 80, 24)
	if err != nil {
		t.Fatalf("OpenPty: %v", err)
	}
	defer stream.Close()

	select {
	case out := <-stream.Output():
		if string(out) != "hello-from-pty" {
			t.Fatalf("output = %q", out)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for pty output")
	}

	if _, err := stream.Write([]byte("ls\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := stream.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("timeout waiting for server to receive frames")
	}

	if gotPath != "/ws/pty/sess-xyz" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotQuery != "cols=80&rows=24" {
		t.Fatalf("query = %q", gotQuery)
	}
	if string(gotInput) != "ls\n" {
		t.Fatalf("input = %q", gotInput)
	}
	if gotResize != EncodePtyResize("sess-xyz", 100, 30) {
		t.Fatalf("resize = %q", gotResize)
	}
}

func TestIntegration_WatchStatus_Optional(t *testing.T) {
	base := strings.TrimSpace(os.Getenv("FLOCK_URL"))
	if base == "" {
		t.Skip("FLOCK_URL not set")
	}
	c, err := New(base, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	if tok := os.Getenv("FLOCK_SESSION_COOKIE"); tok != "" {
		_ = c.SetSessionCookie("", tok)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ch, err := c.WatchStatus(ctx)
	if err != nil {
		t.Fatalf("WatchStatus against FLOCK_URL: %v", err)
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}
