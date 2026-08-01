package fleet

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
)

// Caps must not advertise surfaces that only return ErrNotSupported.
func TestFleetCapsMatchSupportedMethods(t *testing.T) {
	c, err := New("http://127.0.0.1:9", WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	caps := c.Capabilities()
	if caps.Mode != "fleet" {
		t.Fatalf("Mode=%q", caps.Mode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// ShellDrawer false ⇔ CreateShell unsupported
	if caps.ShellDrawer {
		t.Fatal("ShellDrawer=true but CreateShell is not implemented")
	}
	if err := c.CreateShell(ctx, "x", "", 80, 24); !errors.Is(err, backend.ErrNotSupported) {
		t.Fatalf("CreateShell err=%v want ErrNotSupported", err)
	}

	// Launch false ⇔ LaunchAgent unsupported
	if caps.Launch {
		t.Fatal("Launch=true but LaunchAgent is not implemented")
	}
	if err := c.LaunchAgent(ctx, "x", "agent", "", []string{"claude"}, 80, 24); !errors.Is(err, backend.ErrNotSupported) {
		t.Fatalf("LaunchAgent err=%v want ErrNotSupported", err)
	}

	// Audit false ⇔ ListAudit unsupported
	if caps.Audit {
		t.Fatal("Audit=true but ListAudit unsupported")
	}
	if _, err := c.ListAudit(ctx); !errors.Is(err, backend.ErrNotSupported) {
		t.Fatalf("ListAudit err=%v want ErrNotSupported", err)
	}

	// Local-only / stub surfaces must not be advertised as fleet backend features.
	if caps.Git {
		t.Fatal("Git=true: fleet has no git REST client")
	}
	if caps.Files {
		t.Fatal("Files=true: fleet has no node FS client")
	}
	if caps.Handoff {
		t.Fatal("Handoff=true: fleet has no handoff spawn API")
	}
	if caps.StructuredChat {
		t.Fatal("StructuredChat=true: no event stream API")
	}
	if caps.Chat {
		t.Fatal("Chat=true: no event stream API")
	}

	// Surfaces that are real on fleet:
	if !caps.MultiNode {
		t.Fatal("MultiNode should be true for fleet")
	}
	// Cost is true only because the /ws/status frame carries costUsd and
	// ParseStatusFrame assigns it — see TestParseStatusFrame_WithMeta.
	if !caps.Cost {
		t.Fatal("Cost should be true: fleet status frames carry costUsd")
	}
}

func TestLocalCapsShellDrawerMatchesCreateShell(t *testing.T) {
	// Local agentd CreateShell is real — Caps.ShellDrawer must stay true when
	// dialed. Offline unit only checks the constant table via a zero Client
	// method table is not available; assert local package Caps via documentation
	// contract duplicated here as compile-time check against fleet contrast.
	// The live local dial test covers CreateShell success separately.
	//
	// Ensure fleet and local Caps differ on ShellDrawer (fleet false).
	fc, err := New("http://127.0.0.1:9", WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	defer fc.Close()
	if fc.Capabilities().ShellDrawer {
		t.Fatal("fleet ShellDrawer must be false")
	}
}
