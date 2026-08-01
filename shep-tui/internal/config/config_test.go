package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultIsLocal(t *testing.T) {
	cfg := Default()
	if cfg.Active().Mode != ModeLocal {
		t.Fatalf("mode = %q", cfg.Active().Mode)
	}
	if cfg.UI.Scrollback != 10000 {
		t.Fatalf("scrollback = %d", cfg.UI.Scrollback)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)

	cfg := Default()
	cfg.DefaultProfile = "home"
	cfg.Profiles["home"] = Profile{Mode: ModeFleet, URL: "https://flock.example"}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}

	st, err := os.Stat(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %o, want 0600", st.Mode().Perm())
	}

	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultProfile != "home" {
		t.Fatalf("profile = %q", got.DefaultProfile)
	}
	if got.Profiles["home"].URL != "https://flock.example" {
		t.Fatalf("url = %q", got.Profiles["home"].URL)
	}
	if got.Active().Mode != ModeFleet {
		t.Fatalf("active mode = %q", got.Active().Mode)
	}
}

func TestFlockURLEnvPromotesFleet(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("FLOCK_URL", "https://fleet.test")

	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Active().Mode != ModeFleet {
		t.Fatalf("mode = %q", got.Active().Mode)
	}
	if got.Active().URL != "https://fleet.test" {
		t.Fatalf("url = %q", got.Active().URL)
	}
}

func TestDefaultAgentdSocketUsesRuntimeDir(t *testing.T) {
	t.Setenv("FLOCK_AGENTD_SOCKET", "")
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	// Clear explicit socket override from other tests
	_ = os.Unsetenv("FLOCK_AGENTD_SOCKET")
	got := DefaultAgentdSocket()
	want := "/run/user/1000/flock-agentd.sock"
	if got != want {
		t.Fatalf("socket = %q want %q", got, want)
	}
}

// A typo'd default_profile used to fall back to "local" and dial the wrong
// backend. It is an error now.
func TestUnknownDefaultProfileIsAnError(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("SHEP_TUI_PROFILE", "")

	cfg := Default()
	cfg.Profiles["work"] = Profile{Mode: ModeLocal}
	cfg.DefaultProfile = "wrok"
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}

	_, err := Load()
	if err == nil {
		t.Fatal("unknown default_profile must not load")
	}
	for _, want := range []string{"wrok", "local", "work", filepath.Join(dir, "config.toml")} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
}

// SHEP_TUI_PROFILE=typo used to materialize a zero-value profile in the map.
func TestEnvProfileNeverFabricatesAProfile(t *testing.T) {
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	t.Setenv("SHEP_TUI_PROFILE", "stagng")
	t.Setenv("FLOCK_AGENTD_SOCKET", "/tmp/nope.sock")

	if _, err := Load(); err == nil {
		t.Fatal("a profile that does not exist must be an error")
	}

	cfg := Default()
	applyEnv(cfg)
	if _, ok := cfg.Profiles["stagng"]; ok {
		t.Fatal("env must not insert a profile into the map")
	}
}

func TestFleetProfileNeedsURL(t *testing.T) {
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	cfg := Default()
	cfg.Profiles["fleet"] = Profile{Mode: ModeFleet}
	if errs := cfg.Validate(); len(errs) != 1 {
		t.Fatalf("validate errors = %v", errs)
	}
}

// Load applies env; LoadRaw must not, or a Save would persist env values.
func TestLoadRawIgnoresEnvAndSaveOmitsSecret(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("SHEP_TUI_PROFILE", "")
	t.Setenv("FLOCK_AGENTD_SECRET", "env-secret")

	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Active().AgentdSecret != "env-secret" {
		t.Fatal("Load must apply the env secret")
	}

	raw, err := LoadRaw()
	if err != nil {
		t.Fatal(err)
	}
	if raw.Active().AgentdSecret != "" {
		t.Fatalf("LoadRaw leaked the env secret: %q", raw.Active().AgentdSecret)
	}
	if err := Save(raw); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "agentd_secret") {
		t.Fatalf("saved config materialized a secret:\n%s", data)
	}
}

func TestResolvedAgentdControlUsesProtectedFileAndDevelopmentDefault(t *testing.T) {
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "agentd-secret")
	if err := os.WriteFile(secretFile, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	nodeID, secret, err := (Profile{AgentdSecretFile: secretFile}).ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if nodeID != "development-local" || secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("node=%q secret=%q", nodeID, secret)
	}
	if err := os.Chmod(secretFile, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := (Profile{AgentdSecretFile: secretFile}).ResolvedAgentdControl(); err == nil {
		t.Fatal("expected permissive secret file to be rejected")
	}
}

func TestWriteFileAtomicReplacesAndSetsPerms(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	path := filepath.Join(dir, "f.toml")
	if err := WriteFileAtomic(path, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "two" {
		t.Fatalf("content = %q", data)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("file perm = %o", st.Mode().Perm())
	}
	dst, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	// The config dir also holds protected credential files and cookies.json.
	if dst.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm = %o, want 0700", dst.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %d entries", len(entries))
	}
}

func TestOverridesAreTheHighestLayer(t *testing.T) {
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	cfg := Default()
	cfg.Profiles["fleet"] = Profile{Mode: ModeFleet, URL: "https://x"}
	Overrides{Profile: "fleet", Theme: "flock-light", Scrollback: 4242}.Apply(cfg)
	if cfg.DefaultProfile != "fleet" || cfg.UI.Theme != "flock-light" || cfg.UI.Scrollback != 4242 {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
	Overrides{Socket: "/tmp/s.sock"}.Apply(cfg)
	if cfg.Profiles["fleet"].AgentdSocket != "" {
		t.Fatal("--socket must not touch a fleet profile")
	}
	// A flag that does nothing must say so: silence is how people end up
	// debugging the wrong machine.
	if len(cfg.Warnings) != 1 || !strings.Contains(cfg.Warnings[0], "--socket ignored") {
		t.Fatalf("warnings = %v, want one --socket warning", cfg.Warnings)
	}
}

// The profile-scoped env vars must land on the profile that is dialed, not on
// whichever one the file happened to name before --profile moved it.
func TestFlagProfileIsResolvedBeforeTheEnvLayer(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("SHEP_TUI_PROFILE", "")
	t.Setenv("FLOCK_AGENTD_SOCKET", "/tmp/env.sock")
	t.Setenv("FLOCK_AGENTD_SECRET", "s3cret")

	cfg := Default()
	cfg.Profiles["work"] = Profile{Mode: ModeLocal, AgentdSocket: "/tmp/file.sock"}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}

	got, err := LoadWith(Overrides{Profile: "work"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ActiveName() != "work" {
		t.Fatalf("active profile = %q, want work", got.ActiveName())
	}
	if sock := got.Active().ResolvedSocket(); sock != "/tmp/env.sock" {
		t.Fatalf("socket = %q, want the env value on the dialed profile", sock)
	}
	if got.Active().AgentdSecret != "s3cret" {
		t.Fatal("the secret was applied to a profile that is not the one being dialed")
	}
	if got.Profiles["local"].AgentdSecret != "" {
		t.Fatal("env leaked onto the file's default profile")
	}
}

// --profile outranks SHEP_TUI_PROFILE: the flag is the top layer.
func TestFlagProfileBeatsEnvProfile(t *testing.T) {
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	t.Setenv("SHEP_TUI_PROFILE", "local")

	cfg := Default()
	cfg.Profiles["work"] = Profile{Mode: ModeLocal}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	got, err := LoadWith(Overrides{Profile: "work"})
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultProfile != "work" {
		t.Fatalf("default_profile = %q, want the flag's", got.DefaultProfile)
	}
}

// A typo in an enum setting used to run the default in silence, which is
// indistinguishable from a config file that is never read.
func TestUnknownEnumsAreAnError(t *testing.T) {
	cases := map[string]func(*Config){
		"ui.theme":              func(c *Config) { c.UI.Theme = "flock-drak" },
		"ui.pen_default_layout": func(c *Config) { c.UI.PenDefaultLayout = "grid" },
		"keybinds.preset":       func(c *Config) { c.Keybinds.Preset = "vimm" },
	}
	for name, bad := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
			cfg := Default()
			bad(cfg)
			errs := cfg.Validate()
			if len(errs) != 1 || !strings.Contains(errs[0].Error(), name) {
				t.Fatalf("validate = %v, want one %s error", errs, name)
			}
		})
	}

	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	clean := Default()
	clean.UI.Theme = ""
	clean.UI.PenDefaultLayout = ""
	clean.Keybinds.Preset = ""
	if errs := clean.Validate(); len(errs) > 0 {
		t.Fatalf("unset enums must stay legal: %v", errs)
	}
}
