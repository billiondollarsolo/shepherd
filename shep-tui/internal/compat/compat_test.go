package compat

import (
	"testing"

	"github.com/billiondollarsolo/flock/agentd/proto"
)

func TestCheckAgentd(t *testing.T) {
	capabilities := []string{"pty", "resize", "scrollback", "status", "node-info"}
	if err := CheckAgentd(proto.ProtocolVersion, "1.0.0", capabilities); err != nil {
		t.Fatal(err)
	}
	err := CheckAgentd(0, "0.9.0", capabilities)
	if err == nil {
		t.Fatal("expected protocol too old")
	}
	if want := "0.9.0"; !contains(err.Error(), want) {
		t.Fatalf("error should mention daemon version: %v", err)
	}
	if err := CheckAgentd(proto.ProtocolVersion, "0.2.9", capabilities); err == nil {
		t.Fatal("expected below-minimum daemon error")
	}
	if err := CheckAgentd(proto.ProtocolVersion, "0.3.0", []string{"pty"}); err == nil {
		t.Fatal("expected missing-capability error")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(len(s) > 0 && (func() bool {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		})()))
}
