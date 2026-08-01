// Package cli is the shep-tui entry router for interactive and headless commands.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/app"
	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/backend/dial"
	"github.com/billiondollarsolo/shep-tui/internal/backend/local"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"golang.org/x/term"
)

// Demo pane session IDs used when agentd has no sessions yet.
const (
	demoPaneID0 = "shep-tui-pane-0"
	demoPaneID1 = "shep-tui-pane-1"
)

// Run dispatches subcommands. Empty args or "tui" start the interactive paddock.
func Run(version string, args []string) error {
	if len(args) == 0 {
		return runTUI(version, nil)
	}
	switch args[0] {
	case "tui":
		return runTUI(version, args[1:])
	case "version", "--version", "-V":
		fmt.Println(version)
		return nil
	case "help", "--help", "-h":
		printHelp()
		return nil
	case "doctor":
		return doctor()
	case "up":
		return up()
	case "sessions":
		return sessions(args[1:])
	case "profiles":
		return profilesCmd(args[1:])
	case "compare":
		return compareCmd(args[1:])
	case "audit":
		return auditCmd(args[1:])
	case "cost":
		return costCmd(args[1:])
	case "auth":
		return auth(args[1:])
	default:
		// Bare flags are the paddock's: `shep-tui --profile fleet` used to be an
		// unknown command, and `shep-tui tui --profile fleet` dropped the flag.
		if strings.HasPrefix(args[0], "-") {
			return runTUI(version, args)
		}
		return fmt.Errorf("unknown command %q (try: shep-tui help)", args[0])
	}
}

func printHelp() {
	fmt.Fprintf(os.Stdout, `shep-tui — standalone terminal paddock for coding agents

Usage:
  shep-tui              Start paddock (local agentd by default — no SSH required)
  shep-tui tui          Same as default
  shep-tui <command>

Paddock flags (flag > env > config.toml > default):
  --profile NAME         Profile to dial
  --config-dir DIR       Config directory (default: ~/.config/shep-tui)
  --theme NAME           auto | flock-dark | flock-light
  --socket PATH          agentd unix socket (local profiles)
  --scrollback N         Pane scrollback lines
  --no-splash            Skip the startup splash
  --demo                 Seed two demo shell sessions when the backend has none

Standalone (default — full paddock on this machine):
  up                     Ensure local flock-agentd is running
  doctor                 Local agentd health
  sessions list|spawn|launch|wait|explain|prompt|send|export
  compare                Board over the sessions the backend reports
  cost                   Session costs (only where the backend reports them)
  profiles list|use <name>

Optional fleet (Flock orchestrator multi-machine — not required):
  auth login|status|me   Fleet cookie/token auth
  audit list             Orchestrator audit (no backend implements it yet)

Other:
  version                Print build version
  help                   Show this help

Env (standalone):
  FLOCK_AGENTD_SOCKET    Local agentd unix path (default: XDG runtime)
  FLOCK_AGENTD_NODE_ID   Stable daemon identity
  FLOCK_AGENTD_SECRET_FILE Protected daemon credential file
  FLOCK_AGENTD_SECRET    Ephemeral development credential override
  SHEP_TUI_PROFILE      Profile name (default: local)

Env (optional fleet only):
  FLOCK_URL              Orchestrator base URL
  FLOCK_TOKEN / FLOCK_USER+PASSWORD

Keybinds: tab pens · i input · ctrl+j shell drawer · ctrl+k palette · q quit
Detach:   ctrl+g then g   (in input mode the drawer is ctrl+g then j — ctrl+j is the agent's)

Docs: PRODUCT.md · KEYBINDS.md · NODES.md (standalone vs multi-machine) · TUTORIAL.md
`)
}

// runTUI loads config, opens the active backend via dial.Open, seeds the full
// session list into the paddock (sidebar) and attaches up to MaxPenSessions
// (4) into pen panes — never a hard 2-session clamp.
func runTUI(version string, args []string) error {
	flags, err := parseTUIFlags(args)
	if err != nil {
		return err
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return fmt.Errorf("interactive TUI requires a terminal (tty); try: shep-tui doctor | version | help")
	}

	cfg, err := loadTUIConfig(flags)
	if err != nil {
		return app.RunFatal(fmt.Sprintf("config: %v", err))
	}

	active := cfg.Active()
	if active.Mode == config.ModeLocal || active.Mode == "" {
		sock := active.ResolvedSocket()
		if _, err := os.Stat(sock); err != nil {
			return app.RunFatal(fmt.Sprintf(
				"agentd socket not found: %s\n%v\n\nhint: start flock-agentd serve (or: shep-tui up / doctor)",
				sock, err,
			))
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	client, err := dial.Open(ctx, cfg)
	cancel()
	if err != nil {
		hint := "shep-tui doctor"
		switch {
		case isHandshakeErr(err):
			// The daemon is up and answering — it rejected who we said we were.
			// "start agentd" is the wrong advice here; the credential is.
			hint = "agentd rejected the handshake. It was started with a credential this client does not have.\n" +
				"  set one of:  FLOCK_AGENTD_SECRET=…  ·  FLOCK_AGENTD_SECRET_FILE=/path  ·  agentd_secret_file in config.toml\n" +
				"  node id must match the daemon's --node-id (FLOCK_AGENTD_NODE_ID, currently: " + activeNodeID(active) + ")\n" +
				"  then: shep-tui doctor"
		case active.Mode == config.ModeLocal || active.Mode == "":
			hint = "shep-tui up · shep-tui doctor"
		default:
			hint = "shep-tui auth login · shep-tui doctor (set FLOCK_URL + FLOCK_TOKEN or FLOCK_USER/FLOCK_PASSWORD)"
		}
		return app.RunFatal(fmt.Sprintf("cannot open backend (%s):\n%v\n\nhint: %s", active.Mode, err, hint))
	}

	listCtx, listCancel := context.WithTimeout(context.Background(), 5*time.Second)
	sessions, listErr := client.ListSessions(listCtx)
	listCancel()
	if listErr != nil {
		_ = client.Close()
		return app.RunFatal(fmt.Sprintf("list sessions: %v", listErr))
	}

	// A fresh install has no sessions, and that is what the paddock's empty state
	// is for. Creating two mystery shells behind the user's back made it
	// unreachable — and left them in agentd forever.
	if len(sessions) == 0 && flags.Demo {
		spawnCtx, spawnCancel := context.WithTimeout(context.Background(), 15*time.Second)
		sessions = ensureDemoShells(spawnCtx, client)
		spawnCancel()
	}

	opts := BuildTUIOptions(version, sessions, cfg, client.Capabilities())
	opts.Backend = client
	opts.Keys = loadKeybinds(cfg)
	opts.SkipSplash = flags.NoSplash
	return app.Run(opts)
}

// loadKeybinds merges keybinds.toml over the configured preset. A broken or
// conflicting rebind file is a warning, never a reason to keep the user out of
// the paddock — and a missing one is the common case.
func loadKeybinds(cfg *config.Config) keybinds.Map {
	base := keybinds.Preset(cfg.Keybinds.Preset)
	dir, err := config.Dir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "shep-tui: %v (using %s preset)\n", err, cfg.Keybinds.Preset)
		return base
	}
	km, err := keybinds.LoadTOML(filepath.Join(dir, "keybinds.toml"), base)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shep-tui: %v (using %s preset)\n", err, cfg.Keybinds.Preset)
		return base
	}
	return km
}

func ensureDemoShells(ctx context.Context, be backend.Backend) []domain.Session {
	ids := []string{demoPaneID0, demoPaneID1}
	out := make([]domain.Session, 0, 2)
	for _, id := range ids {
		if err := be.CreateShell(ctx, id, "", 80, 24); err != nil {
			if errors.Is(err, backend.ErrNotSupported) {
				return out
			}
			break
		}
		out = append(out, domain.Session{
			ID:        id,
			Name:      id,
			AgentType: domain.AgentType("shell"),
			Status:    domain.StatusIdle,
		})
	}
	return out
}

// isHandshakeErr reports an agentd handshake rejection: the daemon is reachable
// and answering, but refused our identity. That needs a credential, not a restart.
func isHandshakeErr(err error) bool {
	var h *local.HandshakeError
	return errors.As(err, &h)
}

// activeNodeID is the node id this profile will present to agentd.
func activeNodeID(p config.Profile) string {
	nodeID, _, err := p.ResolvedAgentdControl()
	if err != nil || nodeID == "" {
		return "(unset)"
	}
	return nodeID
}
