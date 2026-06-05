package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRestrictWritesConfinesToAllowDir proves the sandbox actually works on this
// kernel: a child process that applies RestrictWrites([allow]) can write inside
// `allow` but is DENIED writing to a sibling dir. Landlock is irreversible and
// per-process, so the restriction runs in a re-exec'd child (this same test
// binary with SANDBOX_CHILD=1), never the test runner itself.
func TestRestrictWritesConfinesToAllowDir(t *testing.T) {
	if os.Getenv("SANDBOX_CHILD") == "1" {
		runSandboxChild()
		return
	}
	if !Available() {
		t.Skip("landlock not available on this kernel")
	}

	allow := t.TempDir()
	outside := t.TempDir() // sibling, NOT in the allow-list

	cmd := exec.Command(os.Args[0], "-test.run=TestRestrictWritesConfinesToAllowDir")
	cmd.Env = append(os.Environ(),
		"SANDBOX_CHILD=1",
		"SANDBOX_ALLOW="+allow,
		"SANDBOX_OUTSIDE="+outside,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sandbox child did not confine writes as expected: %v\n%s", err, out)
	}
}

// runSandboxChild is the confined child: restrict to $SANDBOX_ALLOW, then assert
// a write inside it SUCCEEDS and a write to $SANDBOX_OUTSIDE is DENIED. Exits
// non-zero (with a reason) on any deviation so the parent test fails loudly.
func runSandboxChild() {
	allow := os.Getenv("SANDBOX_ALLOW")
	outside := os.Getenv("SANDBOX_OUTSIDE")

	if err := RestrictWrites([]string{allow}); err != nil {
		fmt.Println("RestrictWrites error:", err)
		os.Exit(3)
	}
	if err := os.WriteFile(filepath.Join(allow, "ok.txt"), []byte("x"), 0o644); err != nil {
		fmt.Println("write inside allow-dir failed (should succeed):", err)
		os.Exit(4)
	}
	if err := os.WriteFile(filepath.Join(outside, "bad.txt"), []byte("x"), 0o644); err == nil {
		fmt.Println("write OUTSIDE allow-dir succeeded — sandbox did NOT confine")
		os.Exit(5)
	}
	// Reads outside the allow-dir must still work (we only confine writes).
	if _, err := os.ReadDir(outside); err != nil {
		fmt.Println("read outside allow-dir failed (reads should be unrestricted):", err)
		os.Exit(6)
	}
	os.Exit(0)
}

func TestABIVersionPositiveWhenAvailable(t *testing.T) {
	if Available() && ABIVersion() < 1 {
		t.Fatalf("Available() true but ABIVersion()=%d", ABIVersion())
	}
}
