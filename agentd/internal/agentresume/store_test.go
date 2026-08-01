package agentresume

import (
	"path/filepath"
	"testing"
)

func TestStorePutListRelaunch(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put(Record{
		SessionID: "s1",
		AgentKind: "claude",
		ResumeRef: "abc",
		Cwd:       "/tmp/proj",
	}); err != nil {
		t.Fatal(err)
	}
	// reopen
	s2, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	r, ok := s2.Get("s1")
	if !ok || r.ResumeRef != "abc" {
		t.Fatalf("%v %v", r, ok)
	}
	cmds := s2.RelaunchCommands()
	if len(cmds) != 1 || cmds[0].Command[0] != "claude" {
		t.Fatalf("%v", cmds)
	}
	_ = filepath.Join(dir, "resume-sessions.json")
}
