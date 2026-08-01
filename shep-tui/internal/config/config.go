// Package config loads shep-tui profiles and paths (XDG).
//
// Precedence for every setting is: flag > env > config file > default.
// Flags arrive as Overrides (see internal/cli/flags.go) and are applied last.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// Mode selects the backend transport.
type Mode string

const (
	ModeLocal Mode = "local"
	ModeFleet Mode = "fleet"
)

// Profile is one named connection target.
type Profile struct {
	Mode         Mode   `toml:"mode"`
	URL          string `toml:"url"`        // fleet
	TokenFile    string `toml:"token_file"` // path to 0600 token (fleet)
	AgentdSocket string `toml:"agentd_socket"`
	AgentdNodeID string `toml:"agentd_node_id,omitempty"`
	// AgentdSecretFile is the persisted credential reference. Plaintext secret
	// values may arrive through the environment but are never written to config.
	AgentdSecretFile string `toml:"agentd_secret_file,omitempty"`
	AgentdSecret     string `toml:"-"`
}

// UI holds presentation prefs.
type UI struct {
	Theme            string `toml:"theme"` // auto | flock-dark | flock-light
	ReducedMotion    bool   `toml:"reduced_motion"`
	PenDefaultLayout string `toml:"pen_default_layout"`
	Scrollback       int    `toml:"scrollback"`
	Mouse            bool   `toml:"mouse"`
}

// Keybinds selects the base keybind preset. Per-action rebinds live in
// keybinds.toml next to this file (see internal/keybinds.LoadTOML).
type Keybinds struct {
	Preset string `toml:"preset"` // default | vim | tmux
}

// Config is the on-disk configuration root.
type Config struct {
	DefaultProfile string             `toml:"default_profile"`
	Profiles       map[string]Profile `toml:"profiles"`
	UI             UI                 `toml:"ui"`
	Keybinds       Keybinds           `toml:"keybinds"`

	// Warnings are non-fatal problems found while resolving env overrides.
	// The caller is expected to show them; they are never persisted.
	Warnings []string `toml:"-"`
}

// Dir returns the config directory (~/.config/shep-tui or overrides).
// A home directory that cannot be resolved is an error, not a silent redirect
// into os.TempDir where the user's settings would vanish on reboot.
//
// Legacy: FLOCK_TUI_CONFIG_DIR is still honored (rename from flock-tui).
// If neither env nor a shep-tui dir exists but ~/.config/flock-tui does, that
// path is used so existing installs keep settings without a manual move.
func Dir() (string, error) {
	if d := dirOverride; d != "" {
		return d, nil
	}
	if d := os.Getenv("SHEP_TUI_CONFIG_DIR"); d != "" {
		return d, nil
	}
	if d := os.Getenv("FLOCK_TUI_CONFIG_DIR"); d != "" {
		return d, nil
	}
	var preferred string
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		preferred = filepath.Join(xdg, "shep-tui")
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("config dir: %w (set SHEP_TUI_CONFIG_DIR or XDG_CONFIG_HOME)", err)
		}
		preferred = filepath.Join(home, ".config", "shep-tui")
	}
	if st, err := os.Stat(preferred); err == nil && st.IsDir() {
		return preferred, nil
	}
	// Fall back to pre-rename flock-tui config if present.
	legacy := filepath.Join(filepath.Dir(preferred), "flock-tui")
	if st, err := os.Stat(legacy); err == nil && st.IsDir() {
		return legacy, nil
	}
	return preferred, nil
}

// dirOverride is the --config-dir flag layer (highest precedence).
var dirOverride string

// SetDir pins the config directory for the rest of the process.
func SetDir(dir string) {
	dirOverride = dir
}

// Path is the default config.toml location.
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.toml"), nil
}

// DefaultAgentdSocket mirrors flock-agentd's default unix path.
func DefaultAgentdSocket() string {
	if s := os.Getenv("FLOCK_AGENTD_SOCKET"); s != "" {
		return s
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "flock-agentd.sock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("flock-agentd-%d.sock", os.Getuid()))
}

// Default returns a local-first config.
func Default() *Config {
	return &Config{
		DefaultProfile: "local",
		Profiles: map[string]Profile{
			"local": {
				Mode: ModeLocal,
			},
		},
		UI: UI{
			Theme:            "auto",
			PenDefaultLayout: "grid2x2",
			Scrollback:       10000,
			Mouse:            true,
		},
		Keybinds: Keybinds{Preset: "default"},
	}
}

// Load reads config from disk, or Default if missing, then applies env
// overrides and validates. An unresolvable profile is an error — connecting to
// the wrong backend because of a typo is worse than not starting.
func Load() (*Config, error) {
	return LoadWith(Overrides{})
}

// LoadWith is Load with the flag layer folded in. The profile selection is
// resolved *before* the profile-scoped env layer runs, so FLOCK_AGENTD_SOCKET
// and FLOCK_AGENTD_SECRET land on the profile that is actually dialed rather
// than on whichever one the file happened to name.
func LoadWith(o Overrides) (*Config, error) {
	cfg, err := LoadRaw()
	if err != nil {
		return nil, err
	}
	if o.Profile != "" {
		cfg.DefaultProfile = o.Profile
	}
	applyEnv(cfg)
	if o.Profile != "" {
		// The flag layer outranks SHEP_TUI_PROFILE, which applyEnv just applied.
		cfg.DefaultProfile = o.Profile
	}
	o.Apply(cfg)
	if errs := cfg.Validate(); len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return cfg, nil
}

// LoadRaw reads config from disk without env overrides or validation. Saving a
// config loaded with Load would persist env-derived values into the file; the
// writers (profiles use, the settings surface) start from LoadRaw instead.
func LoadRaw() (*Config, error) {
	cfg := Default()
	path, err := Path()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err == nil {
		if _, err := toml.DecodeFile(path, cfg); err != nil {
			return nil, fmt.Errorf("decode %s: %w", path, err)
		}
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]Profile{}
	}
	return cfg, nil
}

// Validate reports configuration that cannot be honored. Load fails on it.
func (c *Config) Validate() []error {
	if c == nil {
		return nil
	}
	var errs []error
	path, err := Path()
	if err != nil {
		return []error{err}
	}
	if c.DefaultProfile != "" {
		if _, ok := c.Profiles[c.DefaultProfile]; !ok {
			errs = append(errs, fmt.Errorf(
				"unknown default_profile %q in %s (available: %s)",
				c.DefaultProfile, path, strings.Join(c.profileNames(), ", ")))
		}
	}
	for _, name := range c.profileNames() {
		p := c.Profiles[name]
		switch p.Mode {
		case ModeLocal, ModeFleet, "":
		default:
			errs = append(errs, fmt.Errorf("profile %q: invalid mode %q (want local or fleet)", name, p.Mode))
		}
		if p.Mode == ModeFleet && strings.TrimSpace(p.URL) == "" {
			errs = append(errs, fmt.Errorf("profile %q: fleet profile needs a url (or set FLOCK_URL)", name))
		}
	}
	errs = append(errs, c.validateEnums(path)...)
	return errs
}

// validateEnums rejects the settings whose consumers fall back silently on an
// unknown value (theme.Named, configuredLayout, keybinds.Preset). A typo that
// runs the default is indistinguishable from a config file that is not read.
// The empty value is always legal: it means "the built-in default".
//
// The value sets are the literals those consumers accept; naming them here
// rather than importing ui/theme and domain keeps config below both.
func (c *Config) validateEnums(path string) []error {
	var errs []error
	switch strings.ToLower(strings.TrimSpace(c.UI.Theme)) {
	case "", "auto", "dark", "light", "flock-dark", "flock-light":
	default:
		errs = append(errs, fmt.Errorf(
			"unknown ui.theme %q in %s (want auto, flock-dark or flock-light)", c.UI.Theme, path))
	}
	switch strings.TrimSpace(c.UI.PenDefaultLayout) {
	case "", "cols", "rows", "grid2x2", "main+stack":
	default:
		errs = append(errs, fmt.Errorf(
			"unknown ui.pen_default_layout %q in %s (want cols, rows, grid2x2 or main+stack)",
			c.UI.PenDefaultLayout, path))
	}
	switch strings.ToLower(strings.TrimSpace(c.Keybinds.Preset)) {
	case "", "default", "vim", "tmux":
	default:
		errs = append(errs, fmt.Errorf(
			"unknown keybinds.preset %q in %s (want default, vim or tmux)", c.Keybinds.Preset, path))
	}
	return errs
}

func (c *Config) profileNames() []string {
	out := make([]string, 0, len(c.Profiles))
	for name := range c.Profiles {
		out = append(out, name)
	}
	// Deterministic, so the error text is stable.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Save writes cfg to the default path with 0600 file / 0700 dir perms.
func Save(cfg *Config) error {
	path, err := Path()
	if err != nil {
		return err
	}
	var buf strings.Builder
	if err := toml.NewEncoder(&buf).Encode(cfg); err != nil {
		return err
	}
	return WriteFileAtomic(path, []byte(buf.String()), 0o600)
}

// WriteFileAtomic writes data to path via a temp file + fsync + rename, so a
// crash mid-write cannot leave a truncated config (or pens file) behind. The
// parent directory is created 0700: it also holds credential files and cookies.json.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op once the rename succeeded
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ActiveName is the name of the profile Active() resolves to (empty if none).
func (c *Config) ActiveName() string {
	if c == nil || c.DefaultProfile == "" {
		return ""
	}
	if _, ok := c.Profiles[c.DefaultProfile]; !ok {
		return ""
	}
	return c.DefaultProfile
}

// Active returns the default profile. There is no fallback to "local": an
// unresolvable profile is caught by Validate, and silently dialing a different
// backend than the one the user named is the bug this avoids.
func (c *Config) Active() Profile {
	if c == nil {
		return Profile{Mode: ModeLocal}
	}
	if p, ok := c.Profiles[c.DefaultProfile]; ok {
		return p
	}
	return Profile{Mode: ModeLocal}
}

// ResolvedSocket returns the agentd unix path for a local profile.
func (p Profile) ResolvedSocket() string {
	if p.AgentdSocket != "" {
		return p.AgentdSocket
	}
	return DefaultAgentdSocket()
}

// DefaultAgentdCredentialFile is where a locally-started agentd's credential
// lives, so any client on the machine can adopt a daemon it did not start.
// Whoever brings the daemon up (flock's run-dev.sh, or `shep-tui up`) writes it
// 0600; every local client reads it. Without a convention like this a credential
// passed only through the daemon's environment is invisible to everyone else,
// and adopting a running daemon becomes impossible.
func DefaultAgentdCredentialFile() string {
	if p := os.Getenv("FLOCK_AGENTD_SECRET_FILE"); p != "" {
		return p
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "flock-agentd.secret")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("flock-agentd-%d.secret", os.Getuid()))
}

// ResolvedAgentdControl returns the out-of-band identity required by the secure
// v2 handshake, resolved highest-precedence first: explicit secret, explicit
// secret file, then the well-known credential file the daemon's owner wrote.
// Standalone insecure-development daemons use the documented local identity and
// an empty credential.
func (p Profile) ResolvedAgentdControl() (nodeID, secret string, err error) {
	nodeID = strings.TrimSpace(p.AgentdNodeID)
	if nodeID == "" {
		nodeID = "development-local"
	}
	secret = strings.TrimSpace(p.AgentdSecret)

	file := p.AgentdSecretFile
	explicit := file != ""
	if secret == "" && !explicit && p.ResolvedSocket() == DefaultAgentdSocket() {
		// Nothing configured: adopt the credential the well-known daemon's owner
		// left behind. Only for that daemon — the file describes the socket at the
		// default path, and handing its secret to some other daemon addressed by an
		// explicit --socket would authenticate against the wrong node. A missing
		// file is the normal case, not an error.
		if candidate := DefaultAgentdCredentialFile(); candidate != "" {
			if _, statErr := os.Stat(candidate); statErr == nil {
				file = candidate
			}
		}
	}
	if secret == "" && file != "" {
		value, readErr := readCredentialFile(file)
		if readErr != nil {
			if !explicit {
				// A well-known file we chose ourselves must never harden into a
				// startup failure; fall through to the empty-credential path.
				return nodeID, "", nil
			}
			return "", "", readErr
		}
		secret = value
	}
	if secret != "" && len(secret) < 32 {
		return "", "", fmt.Errorf("agentd credential must contain at least 32 characters")
	}
	return nodeID, secret, nil
}

// readCredentialFile reads a 0600/0400 credential. The daemon enforces the same
// perms on its side; a world-readable secret is not a secret.
func readCredentialFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("agentd secret file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("agentd secret file %s must be regular and mode 0600 or 0400", path)
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read agentd secret file: %w", err)
	}
	return strings.TrimSpace(string(value)), nil
}

// WriteAgentdCredential persists a freshly generated credential 0600 for the
// daemon we are about to start, so later shep-tui runs (and any other local
// client) can adopt it instead of demanding the user carry a secret by hand.
func WriteAgentdCredential(path, secret string) error {
	if len(secret) < 32 {
		return fmt.Errorf("agentd credential must contain at least 32 characters")
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("agentd credential dir: %w", err)
		}
	}
	return WriteFileAtomic(path, []byte(secret+"\n"), 0o600)
}

// Overrides is the flag layer, applied over env + file.
type Overrides struct {
	Profile    string
	Theme      string
	Socket     string
	Scrollback int
}

// Apply writes the set overrides into cfg. Unset fields are left alone.
func (o Overrides) Apply(cfg *Config) {
	if cfg == nil {
		return
	}
	if o.Profile != "" {
		cfg.DefaultProfile = o.Profile
	}
	if o.Theme != "" {
		cfg.UI.Theme = o.Theme
	}
	if o.Scrollback > 0 {
		cfg.UI.Scrollback = o.Scrollback
	}
	if o.Socket != "" {
		name := cfg.DefaultProfile
		p, ok := cfg.Profiles[name]
		switch {
		case !ok:
			// A flag that does nothing and says nothing is the bug the flag layer
			// exists to remove; applyLocalEnv warns in the same situation.
			cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
				"--socket ignored: no active profile %q", name))
		case p.Mode != ModeLocal && p.Mode != "":
			cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
				"--socket ignored: profile %q is %s, not local", name, p.Mode))
		default:
			p.Mode = ModeLocal
			p.AgentdSocket = o.Socket
			cfg.Profiles[name] = p
		}
	}
}

// applyEnv is the env layer. No branch may insert a profile the user did not
// configure: a fabricated zero-value profile is a connection to the wrong
// backend under the name of the one that was asked for.
func applyEnv(cfg *Config) {
	if name := os.Getenv("SHEP_TUI_PROFILE"); name != "" {
		cfg.DefaultProfile = name
	} else if name := os.Getenv("FLOCK_TUI_PROFILE"); name != "" {
		// Legacy env from the flock-tui rename.
		cfg.DefaultProfile = name
	}
	if url := os.Getenv("FLOCK_URL"); url != "" {
		// FLOCK_URL is a request for fleet mode: it may name the fleet profile
		// into existence, but only under a profile the user pointed us at.
		name := cfg.DefaultProfile
		if name == "" || name == "local" {
			name = "fleet"
			cfg.DefaultProfile = name
		}
		p := cfg.Profiles[name]
		p.Mode = ModeFleet
		p.URL = url
		cfg.Profiles[name] = p
	}
	if sock := os.Getenv("FLOCK_AGENTD_SOCKET"); sock != "" {
		cfg.applyLocalEnv("FLOCK_AGENTD_SOCKET", func(p *Profile) { p.AgentdSocket = sock })
	}
	if secret := os.Getenv("FLOCK_AGENTD_SECRET"); secret != "" {
		cfg.applyLocalEnv("FLOCK_AGENTD_SECRET", func(p *Profile) { p.AgentdSecret = secret })
	}
	if file := os.Getenv("FLOCK_AGENTD_SECRET_FILE"); file != "" {
		cfg.applyLocalEnv("FLOCK_AGENTD_SECRET_FILE", func(p *Profile) { p.AgentdSecretFile = file })
	}
	if nodeID := os.Getenv("FLOCK_AGENTD_NODE_ID"); nodeID != "" {
		cfg.applyLocalEnv("FLOCK_AGENTD_NODE_ID", func(p *Profile) { p.AgentdNodeID = nodeID })
	}
}

// applyLocalEnv mutates the active profile when it is a local one, and says so
// when it is not: an env var that quietly does nothing is how people end up
// debugging the wrong machine.
func (c *Config) applyLocalEnv(name string, set func(*Profile)) {
	p, ok := c.Profiles[c.DefaultProfile]
	if !ok {
		return // Validate reports the unresolvable profile.
	}
	if p.Mode != ModeLocal && p.Mode != "" {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"%s ignored: profile %q is %s, not local", name, c.DefaultProfile, p.Mode))
		return
	}
	p.Mode = ModeLocal
	set(&p)
	c.Profiles[c.DefaultProfile] = p
}
