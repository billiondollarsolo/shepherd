package server

import (
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"flock-agentd/internal/layout"
	"flock-agentd/internal/proto"
	"flock-agentd/internal/session"
)

func dialServer(t *testing.T) (net.Conn, *session.Manager) {
	t.Helper()
	return dialServerWith(t, nil)
}

func dialServerWith(t *testing.T, layouts LayoutStore) (net.Conn, *session.Manager) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	mgr := session.NewManager()
	srv := New(mgr, "test", "", layouts)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = ln.Close(); mgr.CloseAll() })

	cli, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return cli, mgr
}

func mustControl(t *testing.T, c net.Conn, ctrl proto.Control) {
	t.Helper()
	if err := proto.WriteControl(c, ctrl); err != nil {
		t.Fatalf("write control %s: %v", ctrl.Op, err)
	}
}

// readControlOp reads frames until a control with the given op arrives.
func readControlOp(t *testing.T, c net.Conn, op string, timeout time.Duration) proto.Control {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	for {
		typ, payload, err := proto.ReadFrame(c)
		if err != nil {
			t.Fatalf("read frame waiting for %q: %v", op, err)
		}
		if typ == proto.TypeControl {
			ctrl, _ := proto.DecodeControl(payload)
			if ctrl.Op == op {
				return ctrl
			}
		}
	}
}

// readDataUntil reads frames until a data frame for sid contains want.
func readDataUntil(t *testing.T, c net.Conn, sid, want string, timeout time.Duration) string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	var sb strings.Builder
	for {
		typ, payload, err := proto.ReadFrame(c)
		if err != nil {
			t.Fatalf("read frame waiting for %q: %v (so far %q)", want, err, sb.String())
		}
		if typ == proto.TypePtyOutput {
			gotSid, data, _ := proto.DecodeData(payload)
			if gotSid == sid {
				sb.Write(data)
				if strings.Contains(sb.String(), want) {
					return sb.String()
				}
			}
		}
	}
}

func TestHelloHandshake(t *testing.T) {
	cli, _ := dialServer(t)
	mustControl(t, cli, proto.Control{Op: "hello"})
	ok := readControlOp(t, cli, "helloOk", 2*time.Second)
	if ok.ProtocolVersion != proto.ProtocolVersion || ok.DaemonVersion != "test" {
		t.Fatalf("bad helloOk: %+v", ok)
	}
}

func TestOpenSubscribeOutput(t *testing.T) {
	cli, _ := dialServer(t)
	mustControl(t, cli, proto.Control{Op: "hello"})
	readControlOp(t, cli, "helloOk", 2*time.Second)

	mustControl(t, cli, proto.Control{Op: "open", ID: "s1", Command: []string{"sh", "-c", "printf hi-agentd; sleep 1"}})
	readControlOp(t, cli, "opened", 2*time.Second)

	mustControl(t, cli, proto.Control{Op: "subscribe", ID: "s1"})
	got := readDataUntil(t, cli, "s1", "hi-agentd", 3*time.Second)
	if !strings.Contains(got, "hi-agentd") {
		t.Fatalf("want hi-agentd, got %q", got)
	}
}

func TestInputEchoedThroughPty(t *testing.T) {
	cli, _ := dialServer(t)
	mustControl(t, cli, proto.Control{Op: "hello"})
	readControlOp(t, cli, "helloOk", 2*time.Second)

	// `cat` echoes stdin → output, proving the input path end-to-end.
	mustControl(t, cli, proto.Control{Op: "open", ID: "c1", Command: []string{"cat"}})
	readControlOp(t, cli, "opened", 2*time.Second)
	mustControl(t, cli, proto.Control{Op: "subscribe", ID: "c1"})

	if err := proto.WriteFrame(cli, proto.TypePtyInput, proto.EncodeData("c1", []byte("pingpong\n"))); err != nil {
		t.Fatalf("write input: %v", err)
	}
	got := readDataUntil(t, cli, "c1", "pingpong", 3*time.Second)
	if !strings.Contains(got, "pingpong") {
		t.Fatalf("want pingpong echoed, got %q", got)
	}
}

func TestListSessions(t *testing.T) {
	cli, _ := dialServer(t)
	mustControl(t, cli, proto.Control{Op: "hello"})
	readControlOp(t, cli, "helloOk", 2*time.Second)
	mustControl(t, cli, proto.Control{Op: "open", ID: "L1", Kind: "shell", Command: []string{"sh", "-c", "sleep 2"}})
	readControlOp(t, cli, "opened", 2*time.Second)

	mustControl(t, cli, proto.Control{Op: "list"})
	got := readControlOp(t, cli, "sessions", 2*time.Second)
	found := false
	for _, s := range got.Sessions {
		if s.ID == "L1" && s.Kind == "shell" {
			found = true
		}
	}
	if !found {
		t.Fatalf("want L1 in session list, got %+v", got.Sessions)
	}
}

func TestLayoutGetSetOverWire(t *testing.T) {
	store, err := layout.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open layout store: %v", err)
	}
	cli, _ := dialServerWith(t, store)
	mustControl(t, cli, proto.Control{Op: "hello"})
	readControlOp(t, cli, "helloOk", 2*time.Second)

	// Unknown workspace → empty layout.
	mustControl(t, cli, proto.Control{Op: "getLayout", Workspace: "proj-a"})
	got := readControlOp(t, cli, "layout", 2*time.Second)
	if got.Workspace != "proj-a" || len(got.Layout) != 0 {
		t.Fatalf("expected empty layout for proj-a, got %+v", got)
	}

	// Set then get round-trips the opaque tree.
	tree := []byte(`{"split":"v","panes":["agent","shell"]}`)
	mustControl(t, cli, proto.Control{Op: "setLayout", Workspace: "proj-a", Layout: tree})
	mustControl(t, cli, proto.Control{Op: "getLayout", Workspace: "proj-a"})
	got = readControlOp(t, cli, "layout", 2*time.Second)
	if string(got.Layout) != string(tree) {
		t.Fatalf("layout round-trip mismatch: got %q want %q", got.Layout, tree)
	}

	// The store persisted it (survives a daemon restart).
	if string(store.Get("proj-a")) != string(tree) {
		t.Fatalf("layout not persisted to store: %q", store.Get("proj-a"))
	}
}
