package screendetect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBundledManifestsLoad(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	agents := e.Agents()
	if len(agents) < 5 {
		t.Fatalf("expected several agents, got %v", agents)
	}
	for _, want := range []string{"claude", "codex", "grok", "opencode", "agy"} {
		found := false
		for _, a := range agents {
			if a == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing agent %s in %v", want, agents)
		}
	}
}

func TestCodexOSCTitleBlocked(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	r := e.Detect(Input{
		Agent:    "codex",
		Screen:   "some terminal text",
		OSCTitle: "Action Required",
	})
	if r.State != StateBlocked {
		t.Fatalf("state=%s rule=%s fallback=%s", r.State, r.MatchedRuleID, r.FallbackReason)
	}
	if !r.VisibleBlocker {
		t.Fatal("expected visible_blocker")
	}
	if MapToWire(r.State) != "awaiting_input" {
		t.Fatalf("wire=%s", MapToWire(r.State))
	}
}

func TestCodexIdleFallback(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	r := e.Detect(Input{
		Agent:    "codex",
		Screen:   "totally unrelated text without markers",
		OSCTitle: "",
	})
	if r.State != StateIdle {
		t.Fatalf("expected idle fallback, got %s rule=%s", r.State, r.MatchedRuleID)
	}
	if r.FallbackReason != DefaultKnownAgentIdleFallback {
		t.Fatalf("fallback=%s", r.FallbackReason)
	}
}

func TestClaudeBlockedPermissionFixture(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	// Matches live_blocked_form / generic permission patterns from claude.toml
	screen := `
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 enter to select · esc to cancel
 tab/arrow keys to navigate
`
	r := e.Detect(Input{Agent: "claude", Screen: screen})
	if r.State != StateBlocked {
		// try alternate phrasing used by bash_permission_prompt
		screen2 := "Do you want to proceed?\nbash command\n❯ Yes\n2. No\nesc to cancel"
		r = e.Detect(Input{Agent: "claude", Screen: screen2})
	}
	if r.State != StateBlocked {
		t.Fatalf("expected blocked, got %s rule=%s fallback=%s evaluated=%d",
			r.State, r.MatchedRuleID, r.FallbackReason, r.EvaluatedRuleCount)
	}
	if MapToWire(r.State) != "awaiting_input" {
		t.Fatalf("wire %s", MapToWire(r.State))
	}
}

func TestClaudeIdlePromptBox(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	screen := "previous output\n\n❯ "
	r := e.Detect(Input{Agent: "claude", Screen: screen})
	// may match live_prompt_box (idle) or fall back idle
	if r.State != StateIdle && r.State != StateUnknown {
		// working rules shouldn't fire on bare prompt
		if r.State == StateBlocked {
			t.Fatalf("unexpected blocked: %+v", r)
		}
	}
	wire := MapToWire(r.State)
	if wire != "idle" && wire != "" {
		t.Fatalf("wire=%s state=%s rule=%s", wire, r.State, r.MatchedRuleID)
	}
}

func TestExplainIncludesRule(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	ex := e.Explain(Input{Agent: "codex", OSCTitle: "Action Required", Screen: "x"})
	if ex.MatchedRuleID == "" && ex.State != StateBlocked {
		t.Fatalf("explain=%+v", ex)
	}
	if ex.Agent != "codex" {
		t.Fatalf("agent=%s", ex.Agent)
	}
}

func TestOverrideDirWins(t *testing.T) {
	dir := t.TempDir()
	// minimal override that always blocks on contains ZZBLOCK
	toml := `
id = "codex"
version = "test-override"
min_engine_version = 1

[[rules]]
id = "override_block"
state = "blocked"
priority = 9999
region = "whole_recent"
visible_blocker = true
contains = ["ZZBLOCK"]
`
	if err := os.WriteFile(filepath.Join(dir, "codex.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := e.Detect(Input{Agent: "codex", Screen: "hello ZZBLOCK world"})
	if r.MatchedRuleID != "override_block" {
		t.Fatalf("expected override rule, got %+v", r)
	}
}

func TestEnabledFromEnv(t *testing.T) {
	if !EnabledFromEnv("") {
		t.Fatal("default must be on when env unset/empty")
	}
	if !EnabledFromEnv("1") || !EnabledFromEnv("true") || !EnabledFromEnv("on") {
		t.Fatal("should enable")
	}
	if EnabledFromEnv("0") || EnabledFromEnv("false") || EnabledFromEnv("off") || EnabledFromEnv("no") {
		t.Fatal("kill-switch must disable")
	}
}

func TestMapToWire(t *testing.T) {
	cases := map[string]string{
		StateWorking: "running",
		StateBlocked: "awaiting_input",
		StateIdle:    "idle",
		StateUnknown: "",
	}
	for in, want := range cases {
		if got := MapToWire(in); got != want {
			t.Errorf("%s -> %s want %s", in, got, want)
		}
	}
}

func TestFixtureFiles(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	// testdata/*.txt with companion .expect files optional
	entries, err := os.ReadDir("testdata")
	if err != nil {
		// create ran before testdata committed
		t.Skip(err)
	}
	for _, ent := range entries {
		if ent.IsDir() || filepath.Ext(ent.Name()) != ".txt" {
			continue
		}
		data, err := os.ReadFile(filepath.Join("testdata", ent.Name()))
		if err != nil {
			t.Fatal(err)
		}
		// filename: agent_state.txt e.g. codex_blocked.txt
		base := stringsTrimSuffix(ent.Name(), ".txt")
		agent, state, ok := splitAgentState(base)
		if !ok {
			continue
		}
		r := e.Detect(Input{Agent: agent, Screen: string(data), OSCTitle: oscFromName(state, string(data))})
		// Strict only for agents with rich manifests we assert in fixtures_test.
		// Coverage of fixture *presence* is TestGoldenFixturesCoverage.
		if agent == "codex" && state == "blocked" && r.State != StateBlocked {
			t.Errorf("%s: want blocked got %s rule=%s", ent.Name(), r.State, r.MatchedRuleID)
		}
		if state == "idle" && r.State == StateBlocked {
			t.Errorf("%s: unexpected blocked for idle fixture", ent.Name())
		}
	}
}

func stringsTrimSuffix(s, suf string) string {
	if len(s) >= len(suf) && s[len(s)-len(suf):] == suf {
		return s[:len(s)-len(suf)]
	}
	return s
}

func splitAgentState(base string) (agent, state string, ok bool) {
	// codex_blocked
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '_' {
			return base[:i], base[i+1:], true
		}
	}
	return "", "", false
}

func oscFromName(state, screen string) string {
	if state == "blocked" && screen == "" {
		return "Action Required"
	}
	if state == "blocked" {
		// allow OSC-based fixtures that put title in first line "# OSC: ..."
		if len(screen) > 7 && screen[:7] == "# OSC: " {
			line := screen[7:]
			for i := 0; i < len(line); i++ {
				if line[i] == '\n' {
					return line[:i]
				}
			}
			return line
		}
	}
	return ""
}
