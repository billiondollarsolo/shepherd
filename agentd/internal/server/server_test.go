package server

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"flock-agentd/internal/controlauth"
	"flock-agentd/internal/identity"
	"flock-agentd/internal/layout"
	"flock-agentd/internal/proto"
	"flock-agentd/internal/session"
)

const testNodeID = "node-test-1234"
const testSecret = "0123456789abcdef0123456789abcdef"

func dialServer(t *testing.T) (net.Conn, *session.Manager) {
	t.Helper()
	return dialServerWith(t, nil)
}

func dialServerWith(t *testing.T, layouts LayoutStore) (net.Conn, *session.Manager) {
	t.Helper()
	dial, mgr, _ := testServerFixture(t, layouts)
	return dial(), mgr
}

func testServerFixture(t *testing.T, layouts LayoutStore) (func() net.Conn, *session.Manager, *Server) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	mgr := session.NewManager()
	srv := New(mgr, "test", testNodeID, testSecret, "", layouts, nil)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = ln.Close(); mgr.CloseAll() })

	dial := func() net.Conn {
		cli, dialErr := net.Dial("unix", sock)
		if dialErr != nil {
			t.Fatalf("dial: %v", dialErr)
		}
		t.Cleanup(func() { _ = cli.Close() })
		return cli
	}
	return dial, mgr, srv
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
	ok := authenticate(t, cli)
	if ok.ProtocolVersion != proto.ProtocolVersion || ok.DaemonVersion != "test" {
		t.Fatalf("bad helloOk: %+v", ok)
	}
}

func TestHandshakeRejectsWrongVersionNodeAndMAC(t *testing.T) {
	tests := []proto.Control{
		{Op: "hello", ProtocolVersion: proto.ProtocolVersion + 1, NodeID: testNodeID, ClientNonce: mustNonce(t), CredentialID: controlauth.CredentialID(testSecret)},
		{Op: "hello", ProtocolVersion: proto.ProtocolVersion, NodeID: "wrong-node", ClientNonce: mustNonce(t), CredentialID: controlauth.CredentialID(testSecret)},
	}
	for _, hello := range tests {
		cli, _ := dialServer(t)
		mustControl(t, cli, hello)
		readControlOp(t, cli, "error", 2*time.Second)
		_ = cli.Close()
	}

	cli, _ := dialServer(t)
	nonce := mustNonce(t)
	mustControl(t, cli, proto.Control{Op: "hello", ProtocolVersion: proto.ProtocolVersion, NodeID: testNodeID, ClientNonce: nonce, CredentialID: controlauth.CredentialID(testSecret)})
	challenge := readControlOp(t, cli, "challenge", 2*time.Second)
	mustControl(t, cli, proto.Control{
		Op: "authenticate", NodeID: testNodeID, ClientNonce: nonce,
		ServerNonce: challenge.ServerNonce, ClientMAC: "invalid",
	})
	readControlOp(t, cli, "error", 2*time.Second)
}

func TestCapturedAuthenticateCannotBeReplayed(t *testing.T) {
	clientNonce := mustNonce(t)
	first, _ := dialServer(t)
	mustControl(t, first, proto.Control{Op: "hello", ProtocolVersion: proto.ProtocolVersion, NodeID: testNodeID, ClientNonce: clientNonce, CredentialID: controlauth.CredentialID(testSecret)})
	oldChallenge := readControlOp(t, first, "challenge", 2*time.Second)
	replayed := proto.Control{
		Op: "authenticate", NodeID: testNodeID, ClientNonce: clientNonce,
		ServerNonce: oldChallenge.ServerNonce,
		ClientMAC: controlauth.MAC(testSecret, "client", testNodeID, clientNonce,
			oldChallenge.ServerNonce, oldChallenge.DaemonVersion, oldChallenge.Capabilities),
	}
	mustControl(t, first, replayed)
	readControlOp(t, first, "helloOk", 2*time.Second)

	second, _ := dialServer(t)
	mustControl(t, second, proto.Control{Op: "hello", ProtocolVersion: proto.ProtocolVersion, NodeID: testNodeID, ClientNonce: clientNonce, CredentialID: controlauth.CredentialID(testSecret)})
	newChallenge := readControlOp(t, second, "challenge", 2*time.Second)
	if newChallenge.ServerNonce == oldChallenge.ServerNonce {
		t.Fatal("server reused authentication nonce")
	}
	mustControl(t, second, replayed)
	readControlOp(t, second, "error", 2*time.Second)
}

func TestCredentialRotationKeepsActiveLinkAndAllowsBoundedReconnect(t *testing.T) {
	dial, _, srv := testServerFixture(t, nil)
	active := dial()
	authenticateWithSecret(t, active, testSecret)
	const next = "next-control-credential-0123456789abcdef"
	mustControl(t, active, proto.Control{Op: "rotateCredential", NewCredential: next})
	rotated := readControlOp(t, active, "credentialRotated", 2*time.Second)
	if rotated.CredentialID != controlauth.CredentialID(next) {
		t.Fatalf("wrong rotation acknowledgement: %+v", rotated)
	}
	// The authenticated connection remains usable, so live PTYs are not dropped.
	mustControl(t, active, proto.Control{Op: "list"})
	readControlOp(t, active, "sessions", 2*time.Second)

	fresh := dial()
	authenticateWithSecret(t, fresh, next)
	// The previous key remains valid only for the bounded overlap window, allowing
	// the orchestrator to commit its encrypted DB reference and reconnect safely.
	overlap := dial()
	authenticateWithSecret(t, overlap, testSecret)
	diagnostics := srv.diagnostics()
	if diagnostics.Rotations != 1 || diagnostics.Connections != 3 {
		t.Fatalf("unexpected control diagnostics: %+v", diagnostics)
	}
}

func TestControlDiagnosticsCountMalformedFramesWithoutLeakingContent(t *testing.T) {
	dial, _, srv := testServerFixture(t, nil)
	client := dial()
	if err := proto.WriteFrame(client, proto.TypeControl, []byte(`{"op":`)); err != nil {
		t.Fatal(err)
	}
	authenticate(t, client)
	diagnostics := srv.diagnostics()
	if diagnostics.Malformed != 1 || diagnostics.Mode != "insecure-development" {
		t.Fatalf("unexpected diagnostics: %+v", diagnostics)
	}
	blob, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte(testSecret)) || bytes.Contains(blob, []byte(`{"op":`)) {
		t.Fatalf("diagnostics leaked credential or malformed payload: %s", blob)
	}
}

func TestCredentialRotationAtomicallyPreservesProtectedFileMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.key")
	if err := os.WriteFile(path, []byte(testSecret+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	srv := &Server{secret: testSecret, credentialFile: path}
	const next = "persisted-control-credential-0123456789"
	if err := srv.rotateCredential(next); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil || strings.TrimSpace(string(body)) != next {
		t.Fatalf("credential file not replaced: %q %v", body, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("credential mode changed: %v %v", info, err)
	}
}

func TestSecureWorkingDirectoryPolicyRejectsEscapeAndCanonicalizes(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	outside := t.TempDir()
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	srv := &Server{runtime: &identity.Runtime{Home: root}}

	valid := session.Spec{Cwd: filepath.Join(root, "workspace", ".")}
	if err := srv.validateSessionSpec(&valid); err != nil {
		t.Fatalf("valid workspace rejected: %v", err)
	}
	if valid.Cwd != workspace {
		t.Fatalf("working directory was not canonicalized: %q", valid.Cwd)
	}

	for _, spec := range []session.Spec{
		{},
		{Cwd: outside},
		{Cwd: filepath.Join(root, "escape")},
		{Cwd: workspace, SandboxAllow: []string{outside}},
	} {
		if err := srv.validateSessionSpec(&spec); err == nil {
			t.Fatalf("unsafe spec accepted: %+v", spec)
		}
	}
}

func mustNonce(t *testing.T) string {
	t.Helper()
	nonce, err := controlauth.Nonce()
	if err != nil {
		t.Fatal(err)
	}
	return nonce
}

func authenticate(t *testing.T, cli net.Conn) proto.Control {
	return authenticateWithSecret(t, cli, testSecret)
}

func authenticateWithSecret(t *testing.T, cli net.Conn, secret string) proto.Control {
	t.Helper()
	clientNonce := mustNonce(t)
	mustControl(t, cli, proto.Control{
		Op: "hello", ProtocolVersion: proto.ProtocolVersion,
		NodeID: testNodeID, ClientNonce: clientNonce, CredentialID: controlauth.CredentialID(secret),
	})
	challenge := readControlOp(t, cli, "challenge", 2*time.Second)
	expectedServerMAC := controlauth.MAC(secret, "server", testNodeID, clientNonce,
		challenge.ServerNonce, challenge.DaemonVersion, challenge.Capabilities)
	if !controlauth.Verify(expectedServerMAC, challenge.ServerMAC) {
		t.Fatal("server did not authenticate")
	}
	mustControl(t, cli, proto.Control{
		Op: "authenticate", NodeID: testNodeID, ClientNonce: clientNonce,
		ServerNonce: challenge.ServerNonce,
		ClientMAC: controlauth.MAC(secret, "client", testNodeID, clientNonce,
			challenge.ServerNonce, challenge.DaemonVersion, challenge.Capabilities),
	})
	return readControlOp(t, cli, "helloOk", 2*time.Second)
}

func TestOpenSubscribeOutput(t *testing.T) {
	cli, _ := dialServer(t)
	authenticate(t, cli)

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
	authenticate(t, cli)

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
	authenticate(t, cli)
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
	authenticate(t, cli)

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
