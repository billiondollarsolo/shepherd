// Code generated from agentd/COMPATIBILITY.json; DO NOT EDIT.
// Regenerate with: go generate ./compatibility

// Package compatibility exposes the release-owned flock-agentd compatibility policy.
package compatibility

// Policy describes the daemon versions, protocols, and authenticated capabilities
// accepted by a Shepherd release.
type Policy struct {
	SchemaVersion             int
	MinimumDaemonVersion      string
	PreferredProtocolVersion  int
	SupportedProtocolVersions []int
	RequiredCapabilities      []string
	OptionalCapabilities      []string
	SupportMinorReleases      int
	SupportMinimumDays        int
}

// Current returns an independent copy of the generated release policy.
func Current() Policy {
	return Policy{
		SchemaVersion:             1,
		MinimumDaemonVersion:      "0.3.0",
		PreferredProtocolVersion:  2,
		SupportedProtocolVersions: []int{2},
		RequiredCapabilities:      []string{"pty", "resize", "scrollback", "status", "node-info"},
		OptionalCapabilities:      []string{"screendetect_v1", "agent_control_v1", "status_authority_v1", "layout", "acp", "claude-stream", "codex-app-server", "listening_ports_v1", "exec_v1", "tcp_tunnel_v1"},
		SupportMinorReleases:      1,
		SupportMinimumDays:        90,
	}
}
