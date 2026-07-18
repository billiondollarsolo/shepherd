package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

// resolveAgent must find an agent installed under a Node version-manager layout
// (nvm/npm) even when it is NOT on the daemon's $PATH — the agent-detection fix.
func TestResolveAgentFindsNvmInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/nonexistent") // ensure LookPath can't find it

	binDir := filepath.Join(home, ".nvm", "versions", "node", "v22.1.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(binDir, "grok")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := resolveAgent("grok"); got != bin {
		t.Fatalf("resolveAgent(grok) = %q, want %q", got, bin)
	}
	// A genuinely-absent agent still resolves to "".
	if got := resolveAgent("definitely-not-installed-xyz"); got != "" {
		t.Fatalf("resolveAgent(absent) = %q, want \"\"", got)
	}
}

func TestResolveAgentFindsHomeLocalBin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/nonexistent")
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(binDir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := resolveAgent("claude"); got != bin {
		t.Fatalf("resolveAgent(claude) = %q, want %q", got, bin)
	}
}

func TestSnapshotSane(t *testing.T) {
	s := Snapshot()
	if s.Cores < 1 {
		t.Fatalf("cores = %d, want >=1", s.Cores)
	}
	if s.MemTotal == 0 {
		t.Fatalf("memTotal = 0, want >0")
	}
	if s.DiskTotal == 0 {
		t.Fatalf("diskTotal = 0, want >0")
	}
	if s.MemUsed > s.MemTotal {
		t.Fatalf("memUsed %d > memTotal %d", s.MemUsed, s.MemTotal)
	}
	if s.Hostname == "" {
		t.Fatalf("hostname empty")
	}
	// Agents slice may be empty (none installed) — just ensure no panic + types.
	for _, a := range s.Agents {
		if a.Name == "" {
			t.Fatalf("agent with empty name")
		}
	}
}
