package cli

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/launch"
)

func TestSessionsLaunchHelpAndParse(t *testing.T) {
	// help path
	out, err := captureStdout(t, func() error {
		return sessionsLaunch([]string{"--help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "--agent") {
		t.Fatalf("help: %s", out)
	}

	// pure launch build path used by CLI (no agentd required)
	agent, err := launch.ParseAgent("claude")
	if err != nil {
		t.Fatal(err)
	}
	res, err := launch.Build(launch.Spec{Agent: agent, Cwd: "/tmp", SessionID: "test-launch-1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "test-launch-1" || res.Command[0] != "claude" {
		t.Fatalf("%+v", res)
	}
}

func TestSessionsLaunchRequiresAgent(t *testing.T) {
	err := sessionsLaunch(nil)
	if err == nil || !strings.Contains(err.Error(), "--agent") {
		t.Fatalf("err=%v", err)
	}
}
