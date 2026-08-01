package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef"

// A daemon this machine already started leaves its credential in the well-known
// file. A client that configured nothing must adopt it, or it cannot talk to a
// daemon it did not start.
func TestAdoptsWellKnownCredentialFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	t.Setenv("FLOCK_AGENTD_SECRET_FILE", "")
	path := filepath.Join(dir, "flock-agentd.secret")
	if err := WriteAgentdCredential(path, testSecret); err != nil {
		t.Fatal(err)
	}

	_, secret, err := Profile{Mode: ModeLocal}.ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if secret != testSecret {
		t.Errorf("secret = %q, want the adopted credential", secret)
	}
}

func TestExplicitSecretBeatsWellKnownFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	if err := WriteAgentdCredential(filepath.Join(dir, "flock-agentd.secret"), testSecret); err != nil {
		t.Fatal(err)
	}
	explicit := strings.Repeat("z", 40)

	_, secret, err := Profile{Mode: ModeLocal, AgentdSecret: explicit}.ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if secret != explicit {
		t.Errorf("secret = %q, want the explicit secret", secret)
	}
}

// The common case is no daemon and no credential anywhere. That must resolve to
// an empty credential, not a startup error.
func TestMissingWellKnownFileIsNotAnError(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("FLOCK_AGENTD_SECRET_FILE", "")

	nodeID, secret, err := Profile{Mode: ModeLocal}.ResolvedAgentdControl()
	if err != nil {
		t.Fatalf("missing credential file must not fail: %v", err)
	}
	if secret != "" || nodeID != "development-local" {
		t.Errorf("got node=%q secret=%q", nodeID, secret)
	}
}

// An explicitly configured file that is missing IS an error: the user asked for
// it by name, so silently falling back to an empty credential would hide a typo.
func TestExplicitMissingSecretFileIsAnError(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	p := Profile{Mode: ModeLocal, AgentdSecretFile: filepath.Join(t.TempDir(), "nope")}
	if _, _, err := p.ResolvedAgentdControl(); err == nil {
		t.Fatal("expected an error for a missing explicit secret file")
	}
}

func TestCredentialFileMustNotBeWorldReadable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "loose.secret")
	if err := os.WriteFile(path, []byte(testSecret), 0o644); err != nil {
		t.Fatal(err)
	}
	p := Profile{Mode: ModeLocal, AgentdSecretFile: path}
	_, _, err := p.ResolvedAgentdControl()
	if err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("world-readable credential must be rejected, got: %v", err)
	}
}

func TestWriteAgentdCredentialIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new.secret")
	if err := WriteAgentdCredential(path, testSecret); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credential mode = %v, want 0600", perm)
	}
}

func TestWriteAgentdCredentialRejectsWeakSecret(t *testing.T) {
	if err := WriteAgentdCredential(filepath.Join(t.TempDir(), "s"), "short"); err == nil {
		t.Fatal("expected a rejection for a credential below agentd's 32-char minimum")
	}
}

// The well-known credential belongs to the daemon on the well-known socket. A
// profile pointed at some other daemon must not present it — that authenticates
// against the wrong node, and a second local daemon (or a test's fake one) would
// be handed a secret it never issued.
func TestDoesNotAdoptCredentialForANonDefaultSocket(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	t.Setenv("FLOCK_AGENTD_SOCKET", "")
	t.Setenv("FLOCK_AGENTD_SECRET_FILE", "")
	if err := WriteAgentdCredential(filepath.Join(dir, "flock-agentd.secret"), testSecret); err != nil {
		t.Fatal(err)
	}

	other := Profile{Mode: ModeLocal, AgentdSocket: filepath.Join(dir, "some-other-daemon.sock")}
	_, secret, err := other.ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if secret != "" {
		t.Errorf("adopted the default daemon's credential for a different socket: %q", secret)
	}

	// …but the default socket still adopts it.
	_, secret, err = Profile{Mode: ModeLocal}.ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if secret != testSecret {
		t.Errorf("default socket must still adopt the published credential, got %q", secret)
	}
}
