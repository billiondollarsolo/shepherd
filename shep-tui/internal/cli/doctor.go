package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend/dial"
	"github.com/billiondollarsolo/shep-tui/internal/backend/fleet"
	"github.com/billiondollarsolo/shep-tui/internal/backend/local"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

// doctor reports connectivity and config health.
func doctor() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	dir, err := config.Dir()
	if err != nil {
		return err
	}
	fmt.Println("shep-tui doctor")
	fmt.Printf("  config dir:  %s\n", dir)
	fmt.Printf("  profile:     %s (%s)\n", cfg.DefaultProfile, cfg.Active().Mode)

	var failed bool
	active := cfg.Active()
	switch active.Mode {
	case config.ModeLocal, "":
		failed = doctorLocal(active)
	case config.ModeFleet:
		failed = doctorFleet(cfg, active)
	default:
		fmt.Printf("  mode:        FAIL (unknown %q)\n", active.Mode)
		failed = true
	}

	if failed {
		return fmt.Errorf("doctor found problems")
	}
	fmt.Println("  result:      ok")
	return nil
}

func doctorLocal(active config.Profile) bool {
	sock := active.ResolvedSocket()
	fmt.Printf("  agentd sock: %s\n", sock)
	st, err := os.Stat(sock)
	if err != nil {
		fmt.Printf("  agentd:      NOT FOUND (%v)\n", err)
		fmt.Println("  hint:        shep-tui up   # or: flock-agentd serve")
		return true
	}
	fmt.Printf("  agentd:      socket present (mode %s)\n", st.Mode())
	nodeID, secret, controlErr := active.ResolvedAgentdControl()
	if controlErr != nil {
		fmt.Printf("  identity:    FAIL (%v)\n", controlErr)
		return true
	}
	fmt.Printf("  node id:     %s\n", nodeID)
	if secret != "" {
		fmt.Println("  secret:      set (profile/env)")
	} else {
		fmt.Println("  secret:      empty (development-local mode only)")
	}
	client, err := local.Dial(sock, nodeID, secret)
	if err != nil {
		fmt.Printf("  hello:       FAIL (%v)\n", err)
		if secret == "" && os.Getenv("FLOCK_AGENTD_SECRET") == "" {
			fmt.Println("  hint:        set FLOCK_AGENTD_NODE_ID and FLOCK_AGENTD_SECRET_FILE for a prepared daemon")
		}
		return true
	}
	fmt.Printf("  hello:       ok (daemon %s, proto %d)\n", client.DaemonVersion(), proto.ProtocolVersion)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	sessions, err := client.ListSessions(ctx)
	cancel()
	_ = client.Close()
	if err != nil {
		fmt.Printf("  list:        FAIL (%v)\n", err)
		return true
	}
	fmt.Printf("  sessions:    %d", len(sessions))
	if len(sessions) > 0 {
		ids := make([]string, len(sessions))
		for i, s := range sessions {
			ids[i] = s.ID
		}
		fmt.Printf(" (%s)", strings.Join(ids, ", "))
	}
	fmt.Println()
	return false
}

func doctorFleet(cfg *config.Config, active config.Profile) bool {
	url := strings.TrimSpace(active.URL)
	if url == "" {
		url = strings.TrimSpace(os.Getenv("FLOCK_URL"))
	}
	fmt.Printf("  fleet url:   %s\n", url)
	if url == "" {
		fmt.Println("  fleet:       FAIL (no url in profile or FLOCK_URL)")
		return true
	}

	probe, err := fleet.New(url, fleet.WithCookiePath("-"))
	if err != nil {
		fmt.Printf("  fleet:       FAIL (%v)\n", err)
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	setupReq, stErr := probe.AuthStatus(ctx)
	cancel()
	_ = probe.Close()
	if stErr != nil {
		fmt.Printf("  auth status: FAIL (%v)\n", stErr)
		fmt.Println("  hint:        is the orchestrator reachable?")
		return true
	}
	fmt.Printf("  auth status: ok (setupRequired=%v)\n", setupReq)
	if setupReq {
		fmt.Println("  hint:        complete first-run admin setup in the web UI")
	}

	openCtx, openCancel := context.WithTimeout(context.Background(), 15*time.Second)
	be, err := dial.Open(openCtx, cfg)
	openCancel()
	if err != nil {
		fmt.Printf("  me:          FAIL (%v)\n", err)
		fmt.Println("  hint:        shep-tui auth login  or set FLOCK_TOKEN / token_file")
		return true
	}
	defer be.Close()

	if fc, ok := be.(*fleet.Client); ok {
		u := fc.UserInfo()
		if u.Username == "" {
			mctx, mcancel := context.WithTimeout(context.Background(), 5*time.Second)
			me, merr := fc.Me(mctx)
			mcancel()
			if merr != nil {
				fmt.Printf("  me:          FAIL (%v)\n", merr)
				return true
			}
			u = me
		}
		fmt.Printf("  me:          ok (%s, role %s)\n", u.Username, u.Role)
	} else {
		fmt.Println("  me:          ok")
	}

	lctx, lcancel := context.WithTimeout(context.Background(), 5*time.Second)
	sessions, err := be.ListSessions(lctx)
	lcancel()
	if err != nil {
		fmt.Printf("  sessions:    FAIL (%v)\n", err)
		return true
	}
	fmt.Printf("  sessions:    %d", len(sessions))
	if len(sessions) > 0 {
		n := len(sessions)
		if n > 8 {
			n = 8
		}
		ids := make([]string, n)
		for i := 0; i < n; i++ {
			ids[i] = sessions[i].ID
		}
		suffix := ""
		if len(sessions) > 8 {
			suffix = ", …"
		}
		fmt.Printf(" (%s%s)", strings.Join(ids, ", "), suffix)
	}
	fmt.Println()
	caps := be.Capabilities()
	fmt.Printf("  caps:        mode=%s multi_node=%v\n", caps.Mode, caps.MultiNode)
	return false
}
