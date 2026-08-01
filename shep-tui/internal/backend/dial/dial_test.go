package dial_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend/dial"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/flock/agentd/controlauth"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

func TestOpenFleet(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		ck, err := r.Cookie("flock_session")
		if err != nil || ck.Value != "open-tok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"no"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"user":{"id":"u","username":"op","role":"admin"}}`))
	})
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sessions": []any{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	t.Setenv("FLOCK_TOKEN", "open-tok")
	t.Setenv("FLOCK_URL", "")
	t.Setenv("FLOCK_USER", "")
	t.Setenv("FLOCK_PASSWORD", "")
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())

	cfg := &config.Config{
		DefaultProfile: "fleet",
		Profiles: map[string]config.Profile{
			"fleet": {Mode: config.ModeFleet, URL: srv.URL},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	be, err := dial.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer be.Close()
	if be.Capabilities().Mode != "fleet" {
		t.Fatalf("mode = %q", be.Capabilities().Mode)
	}
	list, err := be.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("list = %#v", list)
	}
}

func TestOpenLocal(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "agentd.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			kind, payload, err := proto.ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != proto.TypeControl {
				continue
			}
			var ctrl proto.Control
			if err := json.Unmarshal(payload, &ctrl); err != nil {
				return
			}
			if ctrl.Op == "hello" {
				serverNonce := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
				capabilities := []string{"pty", "resize", "scrollback", "status", "node-info"}
				daemonVersion := "0.3.0"
				_ = proto.WriteControl(conn, proto.Control{
					Op:              "challenge",
					DaemonVersion:   daemonVersion,
					ProtocolVersion: proto.ProtocolVersion,
					NodeID:          ctrl.NodeID,
					ClientNonce:     ctrl.ClientNonce,
					ServerNonce:     serverNonce,
					CredentialID:    ctrl.CredentialID,
					Capabilities:    capabilities,
					ServerMAC: controlauth.MAC("", "server", ctrl.NodeID, ctrl.ClientNonce,
						serverNonce, daemonVersion, capabilities),
				})
				continue
			}
			if ctrl.Op == "authenticate" {
				capabilities := []string{"pty", "resize", "scrollback", "status", "node-info"}
				_ = proto.WriteControl(conn, proto.Control{
					Op:              "helloOk",
					DaemonVersion:   "0.3.0",
					ProtocolVersion: proto.ProtocolVersion,
					NodeID:          "development-local",
					Capabilities:    capabilities,
				})
				continue
			}
		}
	}()

	cfg := &config.Config{
		DefaultProfile: "local",
		Profiles: map[string]config.Profile{
			"local": {
				Mode:         config.ModeLocal,
				AgentdSocket: sock,
			},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	be, err := dial.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = be.Close()
	if be.Capabilities().Mode != "local" {
		t.Fatalf("mode = %q", be.Capabilities().Mode)
	}
}

func TestOpenNilConfig(t *testing.T) {
	_, err := dial.Open(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestOpenFleetMissingURL(t *testing.T) {
	t.Setenv("FLOCK_URL", "")
	t.Setenv("FLOCK_TOKEN", "x")
	cfg := &config.Config{
		DefaultProfile: "fleet",
		Profiles: map[string]config.Profile{
			"fleet": {Mode: config.ModeFleet},
		},
	}
	_, err := dial.Open(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected error")
	}
}
