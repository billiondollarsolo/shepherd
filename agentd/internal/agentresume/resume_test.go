package agentresume

import (
	"strings"
	"testing"
)

func TestClaudeResume(t *testing.T) {
	cmd := Command(Ref{AgentKind: "claude", SessionID: "sess-1", Cwd: "/tmp"})
	if len(cmd) < 3 || cmd[0] != "claude" || cmd[1] != "--resume" || cmd[2] != "sess-1" {
		t.Fatalf("%v", cmd)
	}
}

func TestCodexResume(t *testing.T) {
	cmd := Command(Ref{AgentKind: "codex", SessionID: "roll-9"})
	if strings.Join(cmd, " ") != "codex resume roll-9" {
		t.Fatal(cmd)
	}
}

func TestUnsupportedEmpty(t *testing.T) {
	if Command(Ref{AgentKind: "claude"}) != nil {
		t.Fatal("empty session id")
	}
	if Command(Ref{AgentKind: "unknown", SessionID: "x"}) != nil {
		t.Fatal("unknown agent")
	}
}
