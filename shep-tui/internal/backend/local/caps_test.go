package local

import (
	"context"
	"errors"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
)

func TestLocalStandaloneCapsAreFullPaddock(t *testing.T) {
	// Zero-value client still reports the standalone capability table.
	var c Client
	caps := c.Capabilities()
	if caps.Mode != "local" {
		t.Fatalf("Mode=%q", caps.Mode)
	}
	if caps.MultiNode {
		t.Fatal("standalone must not require multi-node/SSH")
	}
	// Core paddock surfaces must be on without orchestrator.
	need := map[string]bool{
		"Launch":      caps.Launch,
		"Git":         caps.Git,
		"Files":       caps.Files,
		"ShellDrawer": caps.ShellDrawer,
		"Handoff":     caps.Handoff,
		"Chat":        caps.Chat,
	}
	for name, ok := range need {
		if !ok {
			t.Errorf("standalone Caps.%s = false; want true (no fleet required)", name)
		}
	}
	if caps.StructuredChat {
		t.Error("StructuredChat should stay false without ACP stream")
	}
}

// Cost=false ⇔ nothing on the agentd path ever assigns Telemetry.CostUSD: the
// protocol has no cost field, so the paddock must not offer a cost surface.
func TestLocalCapsCostIsFalse(t *testing.T) {
	var c Client
	if c.Capabilities().Cost {
		t.Fatal("Cost=true but agentd status frames carry no cost")
	}
}

// Audit=false ⇔ ListAudit is ErrNotSupported.
func TestLocalCapsAuditMatchesListAudit(t *testing.T) {
	var c Client
	if c.Capabilities().Audit {
		t.Fatal("Audit=true but ListAudit is unsupported")
	}
	if _, err := c.ListAudit(context.Background()); !errors.Is(err, backend.ErrNotSupported) {
		t.Fatalf("ListAudit err=%v want ErrNotSupported", err)
	}
}
