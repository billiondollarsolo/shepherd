package cli

import (
	"flag"
	"fmt"
	"os"

	"github.com/billiondollarsolo/shep-tui/internal/config"
)

// tuiFlags is the flag layer of the settings precedence chain
// (flag > env > config file > default).
type tuiFlags struct {
	Overrides config.Overrides
	ConfigDir string
	NoSplash  bool
	Demo      bool
}

// parseTUIFlags parses the flags accepted by `shep-tui` / `shep-tui tui`.
// A positional argument is an error: `shep-tui tui fleet` silently starting the
// default profile is exactly the class of bug these flags exist to remove.
func parseTUIFlags(args []string) (tuiFlags, error) {
	fs := flag.NewFlagSet("tui", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var f tuiFlags
	fs.StringVar(&f.Overrides.Profile, "profile", "", "profile to dial (overrides default_profile)")
	fs.StringVar(&f.ConfigDir, "config-dir", "", "config directory (default: ~/.config/shep-tui)")
	fs.StringVar(&f.Overrides.Theme, "theme", "", "auto | flock-dark | flock-light")
	fs.StringVar(&f.Overrides.Socket, "socket", "", "agentd unix socket (local profiles)")
	fs.IntVar(&f.Overrides.Scrollback, "scrollback", 0, "pane scrollback lines")
	fs.BoolVar(&f.NoSplash, "no-splash", false, "skip the startup splash")
	fs.BoolVar(&f.Demo, "demo", false, "seed two demo shell sessions when the backend has none")
	if err := fs.Parse(args); err != nil {
		return f, err
	}
	if rest := fs.Args(); len(rest) > 0 {
		return f, fmt.Errorf("unexpected argument %q (try: shep-tui help)", rest[0])
	}
	return f, nil
}

// loadTUIConfig applies the flag layer on top of env + file, and reports what
// the env layer could not honor.
func loadTUIConfig(f tuiFlags) (*config.Config, error) {
	if f.ConfigDir != "" {
		config.SetDir(f.ConfigDir)
	}
	cfg, err := config.LoadWith(f.Overrides)
	if err != nil {
		return nil, err
	}
	for _, w := range cfg.Warnings {
		fmt.Fprintf(os.Stderr, "shep-tui: %s\n", w)
	}
	return cfg, nil
}
