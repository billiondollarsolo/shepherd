package session

import "testing"

func TestIsHookOwnedAgent(t *testing.T) {
	cases := []struct {
		name string
		cmd  []string
		want bool
	}{
		{"direct grok", []string{"grok"}, true},
		{"direct opencode", []string{"opencode"}, true},
		{"direct gemini", []string{"gemini"}, true},
		{"path grok", []string{"/usr/local/bin/grok"}, true},
		// The real Shepherd launch for grok (auth probe + device-code bootstrap).
		{"sh -c exec grok", []string{"sh", "-c", `[ -f "$HOME/.grok/auth.json" ] || [ -n "$XAI_API_KEY" ] || grok login --device-auth; exec grok`}, true},
		{"bash -c exec grok", []string{"bash", "-c", "exec grok"}, true},
		{"claude not hook-owned here", []string{"claude"}, false}, // transcript-owned
		{"plain shell", []string{"bash", "-l"}, false},
		{"empty", nil, false},
		{"htop", []string{"htop"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isHookOwnedAgent(tc.cmd); got != tc.want {
				t.Fatalf("isHookOwnedAgent(%v) = %v, want %v", tc.cmd, got, tc.want)
			}
		})
	}
}
