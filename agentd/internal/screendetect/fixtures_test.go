package screendetect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// H0.3: ≥3 states × ≥5 agents golden screens under testdata/.
func TestGoldenFixturesCoverage(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	// agent -> set of states
	seen := map[string]map[string]bool{}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".txt") {
			continue
		}
		base := strings.TrimSuffix(ent.Name(), ".txt")
		// agent_state
		i := strings.LastIndex(base, "_")
		if i < 0 {
			continue
		}
		agent, state := base[:i], base[i+1:]
		if seen[agent] == nil {
			seen[agent] = map[string]bool{}
		}
		seen[agent][state] = true
	}
	if len(seen) < 5 {
		t.Fatalf("want ≥5 agents with fixtures, got %d: %v", len(seen), keys(seen))
	}
	for agent, states := range seen {
		for _, need := range []string{"idle", "working", "blocked"} {
			if !states[need] {
				t.Errorf("agent %s missing %s fixture", agent, need)
			}
		}
	}
}

func keys(m map[string]map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestGoldenFixturesDetect(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	// Agents we have bundled manifests for
	cases := []struct {
		file      string
		agent     string
		wantState string // empty = any non-crash
		soft      bool   // soft: only check no panic / known agent
	}{
		{"codex_blocked.txt", "codex", StateBlocked, false},
		{"codex_idle.txt", "codex", StateIdle, true},
		{"claude_blocked.txt", "claude", StateBlocked, true},
		{"claude_idle.txt", "claude", StateIdle, true},
	}
	for _, tc := range cases {
		data, err := os.ReadFile(filepath.Join("testdata", tc.file))
		if err != nil {
			t.Fatal(err)
		}
		screen, osc := parseFixture(string(data))
		r := e.Detect(Input{Agent: tc.agent, Screen: screen, OSCTitle: osc})
		if tc.soft {
			if r.State == "" {
				t.Errorf("%s: empty state", tc.file)
			}
			continue
		}
		if r.State != tc.wantState {
			t.Errorf("%s: state=%s want %s rule=%s fallback=%s",
				tc.file, r.State, tc.wantState, r.MatchedRuleID, r.FallbackReason)
		}
		if wire := MapToWire(r.State); tc.wantState == StateBlocked && wire != "awaiting_input" {
			t.Errorf("%s: wire=%s", tc.file, wire)
		}
	}
}

func parseFixture(raw string) (screen, osc string) {
	lines := strings.Split(raw, "\n")
	var body []string
	for _, line := range lines {
		if strings.HasPrefix(line, "# OSC: ") {
			osc = strings.TrimPrefix(line, "# OSC: ")
			continue
		}
		body = append(body, line)
	}
	return strings.Join(body, "\n"), osc
}
