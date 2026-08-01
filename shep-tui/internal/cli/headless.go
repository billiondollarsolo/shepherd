package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/ui/audit"
	"github.com/billiondollarsolo/shep-tui/internal/ui/compare"
	"github.com/billiondollarsolo/shep-tui/internal/ui/cost"
	"github.com/billiondollarsolo/shep-tui/internal/ui/profiles"
)

// profilesCmd dispatches `shep-tui profiles …`.
func profilesCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: shep-tui profiles list|use <name>")
	}
	switch args[0] {
	case "list":
		return profilesList()
	case "use":
		if len(args) < 2 {
			return fmt.Errorf("usage: shep-tui profiles use <name>")
		}
		return profilesUse(args[1])
	case "help", "--help", "-h":
		fmt.Fprintln(os.Stdout, "usage: shep-tui profiles list|use <name>")
		return nil
	default:
		return fmt.Errorf("unknown profiles subcommand %q (try: shep-tui profiles list)", args[0])
	}
}

func profilesList() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	for _, line := range profiles.Lines(cfg) {
		fmt.Println(line)
	}
	return nil
}

// profilesUse persists default_profile. It starts from the raw file: saving a
// config.Load() result would write the env layer (FLOCK_URL, secrets) to disk.
func profilesUse(name string) error {
	cfg, err := config.LoadRaw()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if _, err := profiles.Switch(cfg, name); err != nil {
		return fmt.Errorf("%w (available: %s)", err, strings.Join(profiles.Names(cfg), ", "))
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	fmt.Printf("default profile: %s\n", name)
	return nil
}

// compareCmd prints the run-N compare board over the sessions the backend has.
func compareCmd(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "help", "--help", "-h":
			printCompareHelp()
			return nil
		default:
			return fmt.Errorf("compare: unknown arg %q (try: shep-tui compare help)", args[0])
		}
	}

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := be.ListSessions(ctx)
	if err != nil {
		return fmt.Errorf("compare: list sessions: %w", err)
	}
	if len(list) == 0 {
		fmt.Fprintln(os.Stdout, "no sessions to compare (launch some: shep-tui sessions launch --agent claude)")
		return nil
	}

	cost := be.Capabilities().Cost
	b := compare.Board{ShowCost: cost}
	for _, s := range list {
		run := compare.Run{
			SessionID: s.ID,
			Agent:     string(s.AgentType),
			Model:     s.Telemetry.Model,
			Status:    s.Status,
			Summary:   s.Name,
		}
		if cost && s.Telemetry.CostUSD != nil {
			run.CostUSD = *s.Telemetry.CostUSD
		}
		b.Add(run)
	}
	if cost {
		b.SortByCost()
	}
	for _, line := range b.Lines() {
		fmt.Println(line)
	}
	return nil
}

func printCompareHelp() {
	fmt.Fprint(os.Stdout, `shep-tui compare — run-N-and-compare board over the backend's sessions

Usage:
  shep-tui compare          Compare the sessions the active backend reports
  shep-tui compare help     Help only

Cost is shown only when the backend reports it (local agentd does not).
`)
}

// auditCmd dispatches `shep-tui audit …`.
func auditCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: shep-tui audit list [--filter q]")
	}
	switch args[0] {
	case "list":
		return auditList(args[1:])
	case "help", "--help", "-h":
		fmt.Fprintln(os.Stdout, "usage: shep-tui audit list [--filter q]")
		return nil
	default:
		return fmt.Errorf("unknown audit subcommand %q (try: shep-tui audit list)", args[0])
	}
}

func auditList(args []string) error {
	filter := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--filter" && i+1 < len(args):
			i++
			filter = args[i]
		case len(a) > 9 && a[:9] == "--filter=":
			filter = a[9:]
		default:
			return fmt.Errorf("audit list: unknown arg %q", a)
		}
	}

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	// An empty board and "this backend has no audit log" are different answers,
	// and a script that cannot tell them apart is a script that trusts a silence.
	if !be.Capabilities().Audit {
		return fmt.Errorf("audit list: the %s backend has no audit log", be.Capabilities().Mode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := be.ListAudit(ctx)
	if err != nil {
		if errors.Is(err, backend.ErrNotSupported) {
			return fmt.Errorf("audit list: the %s backend has no audit log", be.Capabilities().Mode)
		}
		return fmt.Errorf("audit list: %w", err)
	}

	entries := make([]audit.Entry, 0, len(raw))
	for _, e := range raw {
		var t time.Time
		if e.Time != "" {
			t, _ = time.Parse(time.RFC3339, e.Time)
		}
		entries = append(entries, audit.Entry{
			Time:   t,
			Action: e.Action,
			Actor:  e.Actor,
			Target: e.Target,
			Detail: e.Detail,
		})
	}
	b := &audit.Browser{Entries: entries}
	b.SetFilter(filter)
	for _, line := range b.Lines() {
		fmt.Println(line)
	}
	return nil
}

// costCmd summarizes session costs from the active backend.
func costCmd(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "help", "--help", "-h":
			fmt.Fprintln(os.Stdout, "usage: shep-tui cost")
			return nil
		}
	}

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	// A table of $0.0000 is not a cost report. A backend that cannot price a
	// session says so, and says nothing else.
	if !be.Capabilities().Cost {
		return fmt.Errorf("cost: the %s backend does not report cost", be.Capabilities().Mode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := be.ListSessions(ctx)
	if err != nil {
		return fmt.Errorf("cost: list sessions: %w", err)
	}
	var tbl cost.Table
	tbl.FromSessions(list)
	for _, line := range tbl.Lines() {
		fmt.Println(line)
	}
	return nil
}
