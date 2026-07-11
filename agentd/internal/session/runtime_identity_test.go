package session

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"flock-agentd/internal/identity"
)

func privilegedRuntimeFixture(t *testing.T) (*identity.Runtime, string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("privilege-drop test requires root (runs in the integration container)")
	}
	runtime, err := identity.Resolve("nobody")
	if err != nil {
		t.Skipf("nobody runtime account unavailable: %v", err)
	}
	workspace, err := os.MkdirTemp("", "flock-runtime-workspace-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(workspace) })
	if err := os.Chown(workspace, int(runtime.UID), int(runtime.GID)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	return runtime, workspace
}

func TestRuntimeIdentityDropsPTYCredentialsAndForcesEnvironment(t *testing.T) {
	runtime, workspace := privilegedRuntimeFixture(t)
	t.Setenv("FLOCK_AGENTD_SECRET", "must-not-reach-agent")
	t.Setenv("FLOCK_AGENTD_CREDENTIAL_FILE", "/root/control-credential")
	t.Setenv("FLOCK_MASTER_KEY", "must-not-reach-agent-either")
	t.Setenv("DATABASE_URL", "postgres://control-plane")
	t.Setenv("LD_PRELOAD", "/root/hostile.so")

	command := fmt.Sprintf(
		"printf 'uid='; id -u; printf 'gid='; id -g; printf 'groups='; id -G; printf 'home=%%s\\nuser=%%s\\nsecret=%%s\\ncredential=%%s\\n' \"$HOME\" \"$USER\" \"${FLOCK_AGENTD_SECRET-}\" \"${FLOCK_AGENTD_CREDENTIAL_FILE-}\"",
	)
	command += "; printf 'master=%s\\ndatabase=%s\\nloader=%s\\n' \"${FLOCK_MASTER_KEY-}\" \"${DATABASE_URL-}\" \"${LD_PRELOAD-}\""
	s, err := Open(Spec{
		ID:       "runtime-identity",
		Cwd:      workspace,
		Command:  []string{"/bin/sh", "-c", command},
		Identity: runtime,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "loader=", 3*time.Second)

	for _, expected := range []string{
		"uid=" + strconv.FormatUint(uint64(runtime.UID), 10),
		"gid=" + strconv.FormatUint(uint64(runtime.GID), 10),
		"home=" + runtime.Home,
		"user=" + runtime.Username,
		"secret=\r\n",
		"credential=\r\n",
		"master=\r\n",
		"database=\r\n",
		"loader=\r\n",
	} {
		if !strings.Contains(out, expected) {
			t.Fatalf("missing %q in runtime output %q", expected, out)
		}
	}
	if strings.Contains(out, "groups=0") || strings.Contains(out, "must-not-reach-agent") {
		t.Fatalf("control identity leaked into child: %q", out)
	}
}

func TestRuntimeIdentityCannotReadControlCredential(t *testing.T) {
	runtime, workspace := privilegedRuntimeFixture(t)
	controlDir, err := os.MkdirTemp("", "flock-control-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(controlDir) })
	if err := os.Chmod(controlDir, 0o700); err != nil {
		t.Fatal(err)
	}
	credential := filepath.Join(controlDir, "credential")
	if err := os.WriteFile(credential, []byte("control-secret-canary"), 0o600); err != nil {
		t.Fatal(err)
	}

	s, err := Open(Spec{
		ID:       "runtime-secret-denial",
		Cwd:      workspace,
		Command:  []string{"/bin/sh", "-c", "cat " + credential + " >/dev/null 2>&1 && echo LEAKED || echo DENIED"},
		Identity: runtime,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "DENIED", 3*time.Second)
	if !strings.Contains(out, "DENIED") || strings.Contains(out, "LEAKED") {
		t.Fatalf("runtime read protected credential: %q", out)
	}
}

func TestRuntimeIdentityCannotConnectControlSocket(t *testing.T) {
	runtime, workspace := privilegedRuntimeFixture(t)
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable for unix-socket adversarial probe")
	}
	controlDir, err := os.MkdirTemp("", "flock-control-socket-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(controlDir) })
	if err := os.Chmod(controlDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(controlDir, "agentd.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socket, 0o600); err != nil {
		t.Fatal(err)
	}

	// Positive control: the daemon/control identity can open the socket.
	accepted := make(chan struct{})
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_ = conn.Close()
		}
		close(accepted)
	}()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatalf("control identity could not connect: %v", err)
	}
	_ = conn.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("control socket positive probe did not complete")
	}

	probe := "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])"
	s, err := Open(Spec{
		ID:       "runtime-socket-denial",
		Cwd:      workspace,
		Command:  []string{"/bin/sh", "-c", python + " -c '" + probe + "' " + socket + " >/dev/null 2>&1 && echo CONNECTED || echo DENIED"},
		Identity: runtime,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "DENIED", 3*time.Second)
	if !strings.Contains(out, "DENIED") || strings.Contains(out, "CONNECTED") {
		t.Fatalf("runtime connected to protected control socket: %q", out)
	}
}

func TestRuntimeIdentityCannotAccessDockerSocket(t *testing.T) {
	runtime, workspace := privilegedRuntimeFixture(t)
	const dockerSocket = "/var/run/docker.sock"
	info, err := os.Stat(dockerSocket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Skip("host Docker socket is not mounted into this adversarial fixture")
	}

	s, err := Open(Spec{
		ID:       "runtime-docker-socket-denial",
		Cwd:      workspace,
		Command:  []string{"/bin/sh", "-c", "if [ -r " + dockerSocket + " ] || [ -w " + dockerSocket + " ]; then echo ACCESSIBLE; else echo DENIED; fi"},
		Identity: runtime,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "DENIED", 3*time.Second)
	if !strings.Contains(out, "DENIED") || strings.Contains(out, "ACCESSIBLE") {
		t.Fatalf("runtime identity can access the Docker control socket: %q", out)
	}
}

func TestRuntimeIdentityPreservesPTYResizeAndScrollback(t *testing.T) {
	runtime, workspace := privilegedRuntimeFixture(t)
	s, err := Open(Spec{
		ID:       "runtime-pty",
		Cwd:      workspace,
		Cols:     80,
		Rows:     24,
		Command:  []string{"/bin/sh", "-c", "printf before-resize; sleep 2"},
		Identity: runtime,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	time.Sleep(200 * time.Millisecond)
	if err := s.Resize(132, 50); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if replay := string(s.Subscribe().Replay); !strings.Contains(replay, "before-resize") {
		t.Fatalf("missing runtime scrollback replay: %q", replay)
	}
}
