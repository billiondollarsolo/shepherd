package launch

import (
	"strings"
	"testing"
)

func TestBuildClaude(t *testing.T) {
	res, err := Build(Spec{Agent: AgentClaude, Cwd: "/tmp", SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "s1" || res.Kind != "agent" {
		t.Fatalf("%+v", res)
	}
	if len(res.Command) < 1 || res.Command[0] != "claude" {
		t.Fatalf("cmd=%v", res.Command)
	}
	if !strings.HasPrefix(res.Cwd, "/") && res.Cwd != "/tmp" {
		// abs path may expand
		t.Log(res.Cwd)
	}
}

func TestBuildShell(t *testing.T) {
	res, err := Build(Spec{Agent: AgentShell, SessionID: "sh1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != "shell" {
		t.Fatal(res.Kind)
	}
	if len(res.Command) < 1 {
		t.Fatal("empty command")
	}
}

func TestBuildCodexWithArgs(t *testing.T) {
	res, err := Build(Spec{Agent: AgentCodex, Args: []string{"--help"}, SessionID: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Command) < 2 || res.Command[1] != "--help" {
		t.Fatalf("%v", res.Command)
	}
}

func TestParseAgent(t *testing.T) {
	a, err := ParseAgent("claude-code")
	if err != nil || a != AgentClaude {
		t.Fatalf("%v %v", a, err)
	}
	if _, err := ParseAgent("nope"); err == nil {
		t.Fatal("expected error")
	}
}
