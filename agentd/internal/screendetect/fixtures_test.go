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
	seen := map[string]map[string]bool{}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".txt") {
			continue
		}
		base := strings.TrimSuffix(ent.Name(), ".txt")
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
		t.Fatalf("want ≥5 agents with fixtures, got %d: %v", len(seen), keysOf(seen))
	}
	for agent, states := range seen {
		for _, need := range []string{"idle", "working", "blocked"} {
			if !states[need] {
				t.Errorf("agent %s missing %s fixture", agent, need)
			}
		}
	}
}

func keysOf(m map[string]map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestGoldenFixturesDetect hard-asserts every fixture's expected lifecycle state
// and wire mapping (AC3 / H1.2). No soft "any non-empty state" acceptance.
func TestGoldenFixturesDetect(t *testing.T) {
	e, err := NewEngine("")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	// Agents we ship manifests for
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".txt") {
			continue
		}
		base := strings.TrimSuffix(ent.Name(), ".txt")
		i := strings.LastIndex(base, "_")
		if i < 0 {
			continue
		}
		agent, wantState := base[:i], base[i+1:]
		// Map fixture want → engine state
		wantEngine := wantState
		wantWire := ""
		switch wantState {
		case "blocked":
			wantEngine = StateBlocked
			wantWire = "awaiting_input"
		case "working":
			wantEngine = StateWorking
			wantWire = "running"
		case "idle":
			wantEngine = StateIdle
			wantWire = "idle"
		default:
			t.Errorf("%s: unknown want state %q", ent.Name(), wantState)
			continue
		}

		data, err := os.ReadFile(filepath.Join("testdata", ent.Name()))
		if err != nil {
			t.Fatal(err)
		}
		screen, osc := parseFixture(string(data))
		// Skip agents without bundled manifests
		found := false
		for _, a := range e.Agents() {
			if a == agent {
				found = true
				break
			}
		}
		if !found {
			t.Logf("skip %s: no manifest for agent %s", ent.Name(), agent)
			continue
		}

		r := e.Detect(Input{Agent: agent, Screen: screen, OSCTitle: osc})
		if r.State != wantEngine {
			t.Errorf("%s: state=%s want %s rule=%q fallback=%q osc=%q screen=%q",
				ent.Name(), r.State, wantEngine, r.MatchedRuleID, r.FallbackReason, osc, truncate(screen, 80))
			continue
		}
		if wire := MapToWire(r.State); wire != wantWire {
			t.Errorf("%s: wire=%s want %s", ent.Name(), wire, wantWire)
		}
	}
}

func parseFixture(raw string) (screen, osc string) {
	var body []string
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "# OSC: ") {
			osc = strings.TrimPrefix(line, "# OSC: ")
			continue
		}
		body = append(body, line)
	}
	return strings.Join(body, "\n"), osc
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
