package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/billiondollarsolo/shep-tui/internal/backend/fleet"
	"github.com/billiondollarsolo/shep-tui/internal/config"
)

// auth dispatches `shep-tui auth <sub>`.
func auth(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: shep-tui auth login|status|me|help")
	}
	switch args[0] {
	case "login":
		return authLogin(args[1:])
	case "status":
		return authStatus(args[1:])
	case "me":
		return authMe(args[1:])
	case "help", "--help", "-h":
		fmt.Fprintln(os.Stdout, `usage: shep-tui auth <command>

Commands:
  login   Sign in to a fleet orchestrator (saves session cookie)
          shep-tui auth login --url URL --user U [--password-stdin]
          The password is prompted for — never passed in argv.
  status  GET /api/auth/status (setupRequired)
  me      GET /api/auth/me using saved cookies / FLOCK_TOKEN

Environment:
  FLOCK_URL       Orchestrator base URL
  FLOCK_USER      Username for login
  FLOCK_PASSWORD  Password for login (prefer the prompt / --password-stdin)
  FLOCK_TOKEN     Pre-issued flock_session cookie value

Cookie file: ~/.config/shep-tui/cookies.json (0600)
DEBT: cookie session auth is interim until U1 tokens.`)
		return nil
	default:
		return fmt.Errorf("unknown auth subcommand %q (try: shep-tui auth help)", args[0])
	}
}

func authLogin(args []string) error {
	fs := flag.NewFlagSet("auth login", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	urlFlag := fs.String("url", "", "orchestrator base URL (or FLOCK_URL)")
	userFlag := fs.String("user", "", "username (or FLOCK_USER)")
	stdinFlag := fs.Bool("password-stdin", false, "read the password from stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}

	baseURL := firstNonEmpty(*urlFlag, os.Getenv("FLOCK_URL"))
	user := firstNonEmpty(*userFlag, os.Getenv("FLOCK_USER"))

	if baseURL == "" {
		if cfg, err := config.Load(); err == nil {
			if p := cfg.Active(); p.Mode == config.ModeFleet {
				baseURL = p.URL
			}
		}
	}
	if baseURL == "" || user == "" {
		return fmt.Errorf("usage: shep-tui auth login --url URL --user U [--password-stdin]\n(or set FLOCK_URL, FLOCK_USER; the password is prompted for)")
	}
	pass, err := readPassword(*stdinFlag)
	if err != nil {
		return err
	}
	if pass == "" {
		return fmt.Errorf("password required (prompt, --password-stdin, or FLOCK_PASSWORD)")
	}

	cookiePath := fleet.DefaultCookiePath()
	client, err := fleet.New(baseURL, fleet.WithCookiePath(cookiePath))
	if err != nil {
		return err
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Login(ctx, user, pass); err != nil {
		return fmt.Errorf("login: %w", err)
	}

	me, err := client.Me(ctx)
	if err != nil {
		fmt.Printf("logged in to %s (cookie saved to %s)\n", client.BaseURL(), cookiePath)
		return nil
	}
	fmt.Printf("logged in as %s (%s) to %s\n", me.Username, me.Role, client.BaseURL())
	fmt.Printf("cookie saved: %s\n", cookiePath)
	return nil
}

// readPassword resolves the fleet password without ever putting it in argv,
// where it lands in the shell history and every ps listing on the box.
func readPassword(fromStdin bool) (string, error) {
	if fromStdin {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", fmt.Errorf("read password from stdin: %w", err)
		}
		return strings.TrimRight(string(raw), "\r\n"), nil
	}
	if pass := os.Getenv("FLOCK_PASSWORD"); pass != "" {
		return pass, nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fmt.Errorf("no tty for the password prompt (use --password-stdin or FLOCK_PASSWORD)")
	}
	fmt.Fprint(os.Stderr, "password: ")
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", fmt.Errorf("read password: %w", err)
	}
	return strings.TrimSpace(string(raw)), nil
}

func authStatus(args []string) error {
	client, err := fleetClientFromArgs(args)
	if err != nil {
		return err
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	need, err := client.AuthStatus(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("setupRequired=%v url=%s\n", need, client.BaseURL())
	return nil
}

func authMe(args []string) error {
	client, err := fleetClientFromArgs(args)
	if err != nil {
		return err
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	me, err := client.Me(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("%s\t%s\t%s\n", me.Username, me.Role, me.ID)
	return nil
}

func fleetClientFromArgs(args []string) (*fleet.Client, error) {
	fs := flag.NewFlagSet("auth", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	urlFlag := fs.String("url", "", "orchestrator base URL (or FLOCK_URL)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	baseURL := firstNonEmpty(*urlFlag, os.Getenv("FLOCK_URL"))
	tokenFile := ""
	if cfg, err := config.Load(); err == nil {
		p := cfg.Active()
		if baseURL == "" && p.Mode == config.ModeFleet && p.URL != "" {
			baseURL = p.URL
		}
		tokenFile = p.TokenFile
	}
	if baseURL == "" {
		return nil, fmt.Errorf("fleet URL required (--url or FLOCK_URL)")
	}
	auth, err := fleet.ResolveAuth(tokenFile)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if auth.Token != "" || (auth.Username != "" && auth.Password != "") {
		return fleet.Dial(ctx, baseURL, auth, fleet.WithCookiePath(fleet.DefaultCookiePath()))
	}
	return fleet.New(baseURL, fleet.WithCookiePath(fleet.DefaultCookiePath()))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
