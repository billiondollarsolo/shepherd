package agentcontrol

import "testing"

func TestEncodeKeys(t *testing.T) {
	s, err := EncodeKeys([]string{"esc", "enter"})
	if err != nil {
		t.Fatal(err)
	}
	if s != "\x1b\r" {
		t.Fatalf("%q", s)
	}
	_, err = EncodeKeys([]string{"not-a-key"})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestPromptPayload(t *testing.T) {
	p := PromptPayload("hi", false)
	if p != "hi\r" {
		t.Fatal(p)
	}
	p = PromptPayload("hi", true)
	if p != "\x1b[200~hi\x1b[201~\r" {
		t.Fatal(p)
	}
}

func TestWaitMatch(t *testing.T) {
	if !WaitMatch("idle", nil) {
		t.Fatal("default should match idle")
	}
	if !WaitMatch("awaiting_input", []string{"blocked"}) {
		t.Fatal("blocked synonym")
	}
	if WaitMatch("running", []string{"idle"}) {
		t.Fatal("should not match")
	}
}

func TestOutputMatch(t *testing.T) {
	line, ok := OutputMatch("a\nfoo bar\nb", "foo", "")
	if !ok || line != "foo bar" {
		t.Fatalf("%v %v", line, ok)
	}
	line, ok = OutputMatch("x\npass 1\n", "", "pass \\d+")
	if !ok {
		t.Fatal("regex")
	}
	_ = line
}

func TestTokenScopeProjectOnly(t *testing.T) {
	tok := TokenScope{ProjectID: "p1", SessionID: "s1"}
	if !tok.Allow(ActionPrompt, "p1") {
		t.Fatal("same project")
	}
	if tok.Allow(ActionPrompt, "p2") {
		t.Fatal("cross project denied")
	}
	if tok.Allow(ActionAdmin, "p1") {
		t.Fatal("admin denied")
	}
	empty := TokenScope{}
	if empty.Allow(ActionList, "p1") {
		t.Fatal("empty scope denied")
	}
}

func TestEnvHasControlCredential(t *testing.T) {
	if EnvHasControlCredential([]string{"PATH=/bin", "HOME=/home/u"}) {
		t.Fatal("clean")
	}
	if !EnvHasControlCredential([]string{"FLOCK_AGENTD_SECRET=supersecret"}) {
		t.Fatal("should detect")
	}
}
