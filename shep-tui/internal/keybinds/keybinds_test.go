package keybinds

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultDetachChord(t *testing.T) {
	m := Default()
	seq := m.Sequence(ActionDetachChord)
	if len(seq) != 2 || seq[0] != "ctrl+g" || seq[1] != "g" {
		t.Fatalf("DetachChord = %#v; want [ctrl+g g] (docs/KEYBINDS.md)", seq)
	}
	// Resolve full chord.
	act, ok := m.Resolve([]string{"ctrl+g", "g"})
	if !ok || act != ActionDetachChord {
		t.Fatalf("Resolve detach = %q %v", act, ok)
	}
	// Format for help.
	if got := FormatChord(seq); got != "ctrl+g then g" {
		t.Fatalf("FormatChord = %q", got)
	}
}

func TestResolveSingleKey(t *testing.T) {
	m := Default()
	act, ok := m.Resolve([]string{"tab"})
	if !ok || act != ActionFocusNext {
		t.Fatalf("tab = %q %v", act, ok)
	}
	act, ok = m.Resolve([]string{"q"})
	if !ok || act != ActionQuit {
		t.Fatalf("q = %q %v", act, ok)
	}
	// Alternates resolve to the same action.
	act, ok = m.Resolve([]string{"ctrl+c"})
	if !ok || act != ActionQuit {
		t.Fatalf("ctrl+c = %q %v", act, ok)
	}
	// Case is significant for bare runes: R responds, r renames.
	if act, _ := m.Resolve([]string{"R"}); act != ActionRespond {
		t.Fatalf("R = %q want Respond", act)
	}
	if act, _ := m.Resolve([]string{"r"}); act != ActionRename {
		t.Fatalf("r = %q want Rename", act)
	}
	if act, _ := m.Resolve([]string{"t"}); act != ActionRetry {
		t.Fatalf("t = %q want Retry", act)
	}
	// Multi-key actions are not Resolve-able as first key alone.
	if _, ok := m.Resolve([]string{"ctrl+g"}); ok {
		t.Fatal("ctrl+g alone should not resolve to DetachChord")
	}
}

func TestIsPrefix(t *testing.T) {
	m := Default()
	if !m.IsPrefix([]string{"g"}) {
		t.Fatal("g starts the scroll-top chord")
	}
	if !m.PrefixOf([]string{"ctrl+g"}, ActionDetachChord) {
		t.Fatal("ctrl+g starts the detach chord")
	}
	if m.PrefixOf([]string{"g"}, ActionDetachChord) {
		t.Fatal("g must not arm a chord in PTY input mode")
	}
	if m.IsPrefix([]string{"g", "g"}) {
		t.Fatal("a complete sequence is not a strict prefix")
	}
	if m.IsPrefix([]string{"tab"}) {
		t.Fatal("tab completes an action; it starts no chord")
	}
}

func TestPresetsValidateClean(t *testing.T) {
	// The vim preset once bound FocusNext to ctrl+w w and FocusPrev to ctrl+w W,
	// which normalized to the same chord and resolved at random.
	for name, m := range map[string]Map{"default": Default(), "vim": Vim(), "tmux": Tmux()} {
		if errs := m.Validate(); len(errs) > 0 {
			t.Fatalf("%s preset: %v", name, errs)
		}
		if _, ok := m.Resolve([]string{"ctrl+g", "g"}); !ok {
			t.Fatalf("%s preset: detach missing", name)
		}
	}
	for i := 0; i < 20; i++ {
		act, ok := Vim().Resolve([]string{"ctrl+w", "w"})
		if !ok || act != ActionFocusNext {
			t.Fatalf("vim ctrl+w w = %q %v (unstable resolution)", act, ok)
		}
	}
}

func TestValidateReportsConflictsAndUnknownActions(t *testing.T) {
	m := Default()
	m["Qiut"] = [][]string{{"x"}}
	m[ActionZen] = [][]string{{"q"}}
	m[ActionHelp] = [][]string{{}}
	errs := m.Validate()
	joined := ""
	for _, e := range errs {
		joined += e.Error() + "\n"
	}
	for _, want := range []string{"unknown action", "already bound to", "empty key sequence"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("Validate missing %q: %s", want, joined)
		}
	}
}

func TestSanitizeRestoresDetach(t *testing.T) {
	m := Merge(Default(), Map{ActionDetachChord: {}})
	if len(m[ActionDetachChord]) != 0 {
		t.Fatal("merge should have dropped detach")
	}
	m.Sanitize()
	if _, ok := m.Resolve([]string{"ctrl+g", "g"}); !ok {
		t.Fatal("Sanitize must restore detach")
	}
}

func TestVimAndTmuxPresets(t *testing.T) {
	v := Vim()
	if seq := v.Sequence(ActionDetachChord); len(seq) != 2 || seq[0] != "ctrl+g" {
		t.Fatalf("vim detach = %#v", seq)
	}
	if act, ok := v.Resolve([]string{"ctrl+w", "p"}); !ok || act != ActionFocusPrev {
		t.Fatalf("vim prev = %q %v", act, ok)
	}
	tm := Tmux()
	if seq := tm.Sequence(ActionDetachChord); len(seq) != 2 || seq[0] != "ctrl+g" {
		t.Fatalf("tmux still lists product detach: %#v", seq)
	}
	if seq := tm.Sequence(ActionDetachTmux); len(seq) != 2 || seq[0] != "ctrl+b" || seq[1] != "d" {
		t.Fatalf("tmux detach alt = %#v", seq)
	}
}

func TestMerge(t *testing.T) {
	base := Default()
	over := Map{ActionQuit: {{"x"}}, ActionHelp: {}} // empty removes Help
	got := Merge(base, over)
	if seq := got.Sequence(ActionQuit); len(seq) != 1 || seq[0] != "x" {
		t.Fatalf("quit override = %#v", seq)
	}
	if _, ok := got[ActionHelp]; ok {
		t.Fatal("empty over should remove Help")
	}
	// base unchanged
	if seq := base.Sequence(ActionQuit); seq[0] != "q" {
		t.Fatalf("base mutated: %#v", seq)
	}
}

func TestLoadTOML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keys.toml")
	body := `
[keybinds]
Quit = ["v"]
Palette = [["ctrl+p"], ["§"]]
DetachChord = ["ctrl+g", "g"]
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := LoadTOML(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if seq := m.Sequence(ActionQuit); len(seq) != 1 || seq[0] != "v" {
		t.Fatalf("quit = %#v", seq)
	}
	if act, ok := m.Resolve([]string{"§"}); !ok || act != ActionPalette {
		t.Fatalf("alternate palette bind = %q %v", act, ok)
	}
	// Unspecified actions remain from the base map.
	if seq := m.Sequence(ActionFocusNext); len(seq) != 1 || seq[0] != "tab" {
		t.Fatalf("focus next = %#v", seq)
	}
	// Detach documented.
	if got := FormatChord(m.Sequence(ActionDetachChord)); got != "ctrl+g then g" {
		t.Fatalf("detach = %q", got)
	}
}

func TestLoadTOMLPreset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keys.toml")
	if err := os.WriteFile(path, []byte("preset = \"tmux\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := LoadTOML(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if act, ok := m.Resolve([]string{"ctrl+b", "d"}); !ok || act != ActionDetachTmux {
		t.Fatalf("preset not applied: %q %v", act, ok)
	}
}

func TestLoadTOMLRejectsConflicts(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keys.toml")
	// Qiut is a typo: today it would load clean and silently do nothing.
	if err := os.WriteFile(path, []byte("[keybinds]\nQiut = [\"x\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTOML(path, nil); err == nil {
		t.Fatal("a typo'd action name must not load clean")
	}
}

func TestLoadTOMLEmptyPath(t *testing.T) {
	m, err := LoadTOML("", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Resolve([]string{"ctrl+g", "g"}); !ok {
		t.Fatal("default detach missing")
	}
}

// A user with no keybinds.toml is the common case: it must not fail startup.
func TestLoadTOMLMissingFileIsDefault(t *testing.T) {
	m, err := LoadTOML(filepath.Join(t.TempDir(), "nope.toml"), Vim())
	if err != nil {
		t.Fatalf("missing file must not error: %v", err)
	}
	if act, ok := m.Resolve([]string{"ctrl+w", "w"}); !ok || act != ActionFocusNext {
		t.Fatalf("missing file must return the base map: %q %v", act, ok)
	}
}

func TestNormalizeKey(t *testing.T) {
	m := Map{ActionQuit: {{"Ctrl-C"}}}
	act, ok := m.Resolve([]string{"ctrl+c"})
	if !ok || act != ActionQuit {
		t.Fatalf("normalize: %q %v", act, ok)
	}
}

func TestMarkdownTable(t *testing.T) {
	out := MarkdownTable(Default(), []Action{ActionQuit, ActionDetachChord})
	if !strings.Contains(out, "`q` / `ctrl+c`") {
		t.Fatalf("alternates not rendered: %s", out)
	}
	if !strings.Contains(out, "`ctrl+g then g`") {
		t.Fatalf("chord not rendered: %s", out)
	}
}
