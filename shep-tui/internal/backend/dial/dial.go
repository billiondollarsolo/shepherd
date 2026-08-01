// Package dial opens a local or fleet Backend from config (avoids import cycles
// with package backend, which must not import its implementations).
package dial

import (
	"context"
	"fmt"
	"strings"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/backend/fleet"
	"github.com/billiondollarsolo/shep-tui/internal/backend/local"
	"github.com/billiondollarsolo/shep-tui/internal/config"
)

// Open dials the backend for cfg's active profile.
//
//   - ModeLocal → local.DialWithRetry (agentd unix socket + secret)
//   - ModeFleet → fleet.Dial (orchestrator URL + cookie/password auth)
//
// ctx bounds dial/retry. Callers should pass a timeout for CLI/TUI startup.
func Open(ctx context.Context, cfg *config.Config) (backend.Backend, error) {
	if cfg == nil {
		return nil, fmt.Errorf("dial.Open: nil config")
	}
	p := cfg.Active()
	switch p.Mode {
	case config.ModeFleet:
		return openFleet(ctx, p)
	case config.ModeLocal, "":
		return openLocal(ctx, p)
	default:
		return nil, fmt.Errorf("dial.Open: unknown profile mode %q", p.Mode)
	}
}

func openLocal(ctx context.Context, p config.Profile) (backend.Backend, error) {
	sock := p.ResolvedSocket()
	nodeID, secret, err := p.ResolvedAgentdControl()
	if err != nil {
		return nil, err
	}
	client, err := local.DialWithRetry(ctx, sock, nodeID, secret, local.RetryOpts{})
	if err != nil {
		return nil, fmt.Errorf("local agentd at %s: %w", sock, err)
	}
	return client, nil
}

func openFleet(ctx context.Context, p config.Profile) (backend.Backend, error) {
	// FLOCK_URL is resolved by config.Load (env > file); re-reading it here would
	// be a second, disagreeing precedence chain.
	base := strings.TrimSpace(p.URL)
	if base == "" {
		return nil, fmt.Errorf("fleet: no url (set profile url or FLOCK_URL)")
	}
	auth, err := fleet.ResolveAuth(p.TokenFile)
	if err != nil {
		return nil, err
	}
	client, err := fleet.Dial(ctx, base, auth, fleet.WithCookiePath(fleet.DefaultCookiePath()))
	if err != nil {
		return nil, err
	}
	return client, nil
}
